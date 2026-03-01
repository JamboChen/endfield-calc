import type { Edge } from "@xyflow/react";
import type {
  Item,
  Facility,
  ItemId,
  ProductionDependencyGraph,
  ProductionGraphNode,
  FlowProductionNode,
  FlowTargetNode,
} from "@/types";
import { CapacityPoolManager } from "../flow/capacity-pool";
import {
  createEdge,
  createProductionFlowNode,
  createTargetSinkNode,
} from "../flow/flow-utils";
import { createTargetSinkId, createPickupPointId } from "@/lib/node-keys";
import {
  calcRate,
  getPickupPointCount,
  TRANSPORT_BELT_CAPACITY,
} from "@/lib/utils";

/**
 * Maps ProductionDependencyGraph to React Flow nodes and edges in separated mode.
 * Each physical facility is represented as an individual node.
 */
export function mapPlanToFlowSeparated(
  plan: ProductionDependencyGraph,
  items: Item[],
  facilities: Facility[],
  beltLabel: string,
  targetRates?: Map<ItemId, number>,
): { nodes: (FlowProductionNode | FlowTargetNode)[]; edges: Edge[] } {
  const poolManager = new CapacityPoolManager();
  const rawMaterialPickupPoints = new Map<
    ItemId,
    { nodeId: string; remainingCapacity: number }[]
  >();
  const flowNodes: FlowProductionNode[] = [];
  const targetSinkNodes: FlowTargetNode[] = [];
  const edges: Edge[] = [];
  let edgeIdCounter = 0;

  // Pre-calculate which items are upstream (have consumers)
  const upstreamItemIds = new Set<string>();
  plan.edges.forEach((edge) => {
    if (plan.nodes.get(edge.from)?.type === "item") {
      upstreamItemIds.add(edge.from);
    }
  });

  // Create pools for all recipe nodes
  plan.nodes.forEach((node, nodeId) => {
    if (node.type === "recipe") {
      const outputItemId = plan.edges.find((e) => e.from === nodeId)?.to;
      const outputItemNode = outputItemId
        ? (plan.nodes.get(outputItemId) as
            | Extract<ProductionGraphNode, { type: "item" }>
            | undefined)
        : undefined;

      if (outputItemNode) {
        poolManager.createPool(
          {
            item: outputItemNode.item,
            targetRate: outputItemNode.productionRate,
            recipe: node.recipe,
            facility: node.facility,
            facilityCount: node.facilityCount,
            isRawMaterial: false,
            isTarget: outputItemNode.isTarget,
            dependencies: [],
          },
          nodeId,
        );
      }
    }
  });

  function ensurePickupPointNodes(
    itemId: ItemId,
    item: Item,
    totalDemand: number,
  ): void {
    if (rawMaterialPickupPoints.has(itemId)) return;

    const count = getPickupPointCount(totalDemand);
    const pickupPoints: { nodeId: string; remainingCapacity: number }[] = [];

    for (let i = 0; i < count; i++) {
      const nodeId = createPickupPointId(itemId, i);
      const capacity = Math.min(
        TRANSPORT_BELT_CAPACITY,
        totalDemand - i * TRANSPORT_BELT_CAPACITY,
      );
      const isPartialLoad = capacity < TRANSPORT_BELT_CAPACITY * 0.999;

      pickupPoints.push({ nodeId, remainingCapacity: capacity });

      flowNodes.push(
        createProductionFlowNode(
          nodeId,
          {
            item,
            targetRate: capacity,
            recipe: null,
            facility: null,
            facilityCount: 0,
            isRawMaterial: true,
            isTarget: false,
            dependencies: [],
          },
          items,
          facilities,
          {
            facilityIndex: i,
            totalFacilities: count,
            isPartialLoad,
            isDirectTarget: false,
          },
        ),
      );
    }

    rawMaterialPickupPoints.set(itemId, pickupPoints);
  }

  function allocateFromPickupPoints(
    itemId: ItemId,
    demandRate: number,
    consumerFacilityId: string,
  ): void {
    const pickupPoints = rawMaterialPickupPoints.get(itemId);
    if (!pickupPoints) return;

    let remainingDemand = demandRate;

    for (const pp of pickupPoints) {
      if (remainingDemand <= 0) break;
      if (pp.remainingCapacity <= 0) continue;

      const allocated = Math.min(pp.remainingCapacity, remainingDemand);
      pp.remainingCapacity -= allocated;
      remainingDemand -= allocated;

      edges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          pp.nodeId,
          consumerFacilityId,
          allocated,
          beltLabel,
        ),
      );
    }
  }

  function allocateUpstream(
    itemId: ItemId,
    demandRate: number,
    consumerFacilityId: string,
  ): void {
    const itemNode = plan.nodes.get(itemId) as
      | Extract<ProductionGraphNode, { type: "item" }>
      | undefined;
    if (!itemNode) return;

    // Find producer recipe
    const producerRecipeId = Array.from(plan.edges).find(
      (e) => e.to === itemId && plan.nodes.get(e.from)?.type === "recipe",
    )?.from;

    if (!producerRecipeId) {
      // Raw material — create pickup point nodes and allocate
      ensurePickupPointNodes(itemId, itemNode.item, itemNode.productionRate);
      allocateFromPickupPoints(itemId, demandRate, consumerFacilityId);
      return;
    }

    // Check for circular dependency (backward edge)
    const isBackward = consumerFacilityId.startsWith(producerRecipeId);

    allocateFromPool(
      producerRecipeId,
      demandRate,
      consumerFacilityId,
      isBackward ? "backward" : undefined,
    );
  }

  function allocateFromPool(
    recipeId: string,
    demandRate: number,
    consumerFacilityId: string,
    edgeDirection?: "backward",
  ): void {
    if (!poolManager.hasPool(recipeId)) {
      console.warn(`Pool not found for ${recipeId}`);
      return;
    }

    const allocations = poolManager.allocate(recipeId, demandRate);
    const recipeNode = plan.nodes.get(recipeId) as Extract<
      ProductionGraphNode,
      { type: "recipe" }
    >;
    const outputItemId = plan.edges.find((e) => e.from === recipeId)?.to;
    const outputItemNode = outputItemId
      ? (plan.nodes.get(outputItemId) as
          | Extract<ProductionGraphNode, { type: "item" }>
          | undefined)
      : undefined;

    if (!recipeNode || !outputItemNode) return;

    allocations.forEach((allocation) => {
      edges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          allocation.sourceNodeId,
          consumerFacilityId,
          allocation.allocatedAmount,
          beltLabel,
          edgeDirection,
        ),
      );

      if (!poolManager.isProcessed(allocation.sourceNodeId)) {
        poolManager.markProcessed(allocation.sourceNodeId);

        const facilityInstance = poolManager
          .getFacilityInstances(recipeId)
          .find((f) => f.facilityId === allocation.sourceNodeId);

        if (facilityInstance) {
          const totalFacilities =
            poolManager.getFacilityInstances(recipeId).length;
          const isPartialLoad =
            facilityInstance.actualOutputRate <
            facilityInstance.maxOutputRate * 0.999;

          // Create facility node
          flowNodes.push(
            createProductionFlowNode(
              allocation.sourceNodeId,
              {
                item: outputItemNode.item,
                targetRate: facilityInstance.actualOutputRate,
                recipe: recipeNode.recipe,
                facility: recipeNode.facility,
                facilityCount: 1,
                isRawMaterial: false,
                isTarget: outputItemNode.isTarget,
                dependencies: [],
              },
              items,
              facilities,
              {
                facilityIndex: facilityInstance.facilityIndex,
                totalFacilities: totalFacilities,
                isPartialLoad: isPartialLoad,
                isDirectTarget: false,
              },
            ),
          );

          recipeNode.recipe.inputs.forEach((input) => {
            const inputDemandRate =
              calcRate(input.amount, recipeNode.recipe.craftingTime) *
              (facilityInstance.actualOutputRate /
                calcRate(
                  recipeNode.recipe.outputs[0].amount,
                  recipeNode.recipe.craftingTime,
                ));

            allocateUpstream(
              input.itemId,
              inputDemandRate,
              allocation.sourceNodeId,
            );
          });
        }
      }
    });
  }

  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "recipe") return;

    const outputItemId = plan.edges.find((e) => e.from === nodeId)?.to;
    const outputItemNode = outputItemId
      ? (plan.nodes.get(outputItemId) as
          | Extract<ProductionGraphNode, { type: "item" }>
          | undefined)
      : undefined;

    if (!outputItemNode || outputItemNode.isTarget) return;

    const facilityInstances = poolManager.getFacilityInstances(nodeId);

    facilityInstances.forEach((facilityInstance) => {
      if (poolManager.isProcessed(facilityInstance.facilityId)) return;

      poolManager.markProcessed(facilityInstance.facilityId);

      const isPartialLoad =
        facilityInstance.actualOutputRate <
        facilityInstance.maxOutputRate * 0.999;

      flowNodes.push(
        createProductionFlowNode(
          facilityInstance.facilityId,
          {
            item: outputItemNode.item,
            targetRate: facilityInstance.actualOutputRate,
            recipe: node.recipe,
            facility: node.facility,
            facilityCount: 1,
            isRawMaterial: false,
            isTarget: false,
            dependencies: [],
          },
          items,
          facilities,
          {
            facilityIndex: facilityInstance.facilityIndex,
            totalFacilities: facilityInstances.length,
            isPartialLoad: isPartialLoad,
            isDirectTarget: false,
          },
        ),
      );

      // Allocate upstream for this facility's dependencies
      node.recipe.inputs.forEach((input) => {
        const inputDemandRate =
          calcRate(input.amount, node.recipe.craftingTime) *
          (facilityInstance.actualOutputRate /
            calcRate(node.recipe.outputs[0].amount, node.recipe.craftingTime));

        allocateUpstream(
          input.itemId,
          inputDemandRate,
          facilityInstance.facilityId,
        );
      });
    });
  });

  // Create target sink nodes
  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "item" || !node.isTarget) return;

    const targetSinkId = createTargetSinkId(node.itemId);

    const producerRecipeId = Array.from(plan.edges).find(
      (e) => e.to === nodeId && plan.nodes.get(e.from)?.type === "recipe",
    )?.from;

    const producerRecipe = producerRecipeId
      ? (plan.nodes.get(producerRecipeId) as
          | Extract<ProductionGraphNode, { type: "recipe" }>
          | undefined)
      : undefined;

    const isTerminalTarget = !upstreamItemIds.has(nodeId);
    const shouldSplit =
      isTerminalTarget &&
      producerRecipe &&
      producerRecipeId &&
      producerRecipe.facilityCount > 1;

    if (shouldSplit) {
      // Split into individual facility nodes
      const facilityInstances =
        poolManager.getFacilityInstances(producerRecipeId);

      facilityInstances.forEach((facilityInstance) => {
        const isPartialLoad =
          facilityInstance.actualOutputRate <
          facilityInstance.maxOutputRate * 0.999;

        flowNodes.push(
          createProductionFlowNode(
            facilityInstance.facilityId,
            {
              item: node.item,
              targetRate: facilityInstance.actualOutputRate,
              recipe: producerRecipe.recipe,
              facility: producerRecipe.facility,
              facilityCount: 1,
              isRawMaterial: false,
              isTarget: true,
              dependencies: [],
            },
            items,
            facilities,
            {
              facilityIndex: facilityInstance.facilityIndex,
              totalFacilities: facilityInstances.length,
              isPartialLoad,
              isDirectTarget: true,
              directTargetRate: facilityInstance.actualOutputRate,
            },
          ),
        );

        // Edge from facility to target sink
        edges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            facilityInstance.facilityId,
            targetSinkId,
            facilityInstance.actualOutputRate,
            beltLabel,
          ),
        );

        // Allocate upstream for this facility
        producerRecipe.recipe.inputs.forEach((input) => {
          const inputDemandRate =
            calcRate(input.amount, producerRecipe.recipe.craftingTime) *
            (facilityInstance.actualOutputRate /
              calcRate(
                producerRecipe.recipe.outputs[0].amount,
                producerRecipe.recipe.craftingTime,
              ));

          allocateUpstream(
            input.itemId,
            inputDemandRate,
            facilityInstance.facilityId,
          );
        });
      });

      // Create target sink WITHOUT productionInfo (shown in facility nodes)
      const userTargetRateSplit =
        targetRates?.get(node.itemId) ?? node.productionRate;
      targetSinkNodes.push(
        createTargetSinkNode(
          targetSinkId,
          node.item,
          userTargetRateSplit,
          items,
          facilities,
          undefined,
        ),
      );
    } else {
      const userTargetRate =
        targetRates?.get(node.itemId) ?? node.productionRate;
      targetSinkNodes.push(
        createTargetSinkNode(
          targetSinkId,
          node.item,
          userTargetRate,
          items,
          facilities,
          producerRecipe
            ? {
                facility: producerRecipe.facility,
                facilityCount: producerRecipe.facilityCount,
                recipe: producerRecipe.recipe,
              }
            : undefined,
        ),
      );

      // Connect dependencies to target sink
      if (producerRecipe && producerRecipeId) {
        if (isTerminalTarget) {
          // Terminal target (single facility): connect recipe inputs directly
          producerRecipe.recipe.inputs.forEach((input) => {
            const inputDemandRate =
              (input.amount / producerRecipe.recipe.outputs[0].amount) *
              userTargetRate;

            allocateUpstream(input.itemId, inputDemandRate, targetSinkId);
          });
        } else {
          // Non-terminal target: allocate from producer recipe's pool
          // so edges go from production facility → target sink
          allocateFromPool(producerRecipeId, userTargetRate, targetSinkId);
        }
      }
    }
  });

  return {
    nodes: [...flowNodes, ...targetSinkNodes],
    edges: edges,
  };
}
