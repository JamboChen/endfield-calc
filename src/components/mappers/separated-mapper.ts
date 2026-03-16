import type { Edge } from "@xyflow/react";
import type {
  Item,
  Facility,
  ItemId,
  ProductionDependencyGraph,
  ProductionGraphNode,
  FlowProductionNode,
  FlowTargetNode,
  FlowDisposalNode,
} from "@/types";
import { CapacityPoolManager } from "../flow/capacity-pool";
import {
  createEdge,
  createProductionFlowNode,
  createTargetSinkNode,
  createDisposalSinkNode,
} from "../flow/flow-utils";
import { createTargetSinkId, createPickupPointId } from "@/lib/node-keys";
import { getRecipeOutputItemId, getRecipeInputItemId, getNonDisposalProducerRecipeId } from "@/lib/plan-helpers";
import {
  calcRate,
  getOutputAmount,
  calcByproductRate,
  getPickupPointCount,
  getTransportCapacity,
} from "@/lib/utils";

/**
 * Maps ProductionDependencyGraph to React Flow nodes and edges in separated mode.
 * Each physical facility is represented as an individual node.
 */
export function mapPlanToFlowSeparated(
  plan: ProductionDependencyGraph,
  items: Item[],
  facilities: Facility[],
  targetRates?: Map<ItemId, number>,
  ceilMode = false,
): { nodes: (FlowProductionNode | FlowTargetNode | FlowDisposalNode)[]; edges: Edge[] } {
  const poolManager = new CapacityPoolManager();
  const rawMaterialPickupPoints = new Map<
    ItemId,
    { nodeId: string; remainingCapacity: number }[]
  >();
  const flowNodes: FlowProductionNode[] = [];
  const targetSinkNodes: FlowTargetNode[] = [];
  const edges: Edge[] = [];
  let edgeIdCounter = 0;

  // Track byproduct capacity already allocated to targets per facility instance.
  // Used to coordinate between target sink and disposal sink passes — disposal
  // only handles the remaining byproduct after target allocation.
  const byproductAllocatedToTarget = new Map<string, number>();

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
      const outputItemId = getRecipeOutputItemId(plan, nodeId);
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

    const count = getPickupPointCount(totalDemand, item);
    const pickupPoints: { nodeId: string; remainingCapacity: number }[] = [];
    const transportCapacity = getTransportCapacity(item);

    for (let i = 0; i < count; i++) {
      const nodeId = createPickupPointId(itemId, i);
      const capacity = Math.min(
        transportCapacity,
        totalDemand - i * transportCapacity,
      );
      const isPartialLoad = capacity < transportCapacity * 0.999;

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
          ceilMode,
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
    item: Item,
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
          item,
          undefined,
          ceilMode,
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
      allocateFromPickupPoints(itemId, itemNode.item, demandRate, consumerFacilityId);
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
    const outputItemId = getRecipeOutputItemId(plan, recipeId);
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
          outputItemNode.item,
          edgeDirection,
          ceilMode,
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
              ceilMode,
              {
                facilityIndex: facilityInstance.facilityIndex,
                totalFacilities: totalFacilities,
                isPartialLoad: isPartialLoad,
                isDirectTarget: false,
              },
            ),
          );

          recipeNode.recipe.inputs.forEach((input) => {
            const outputAmount = getOutputAmount(recipeNode.recipe, outputItemNode.item.id);
            const inputDemandRate =
              calcRate(input.amount, recipeNode.recipe.craftingTime) *
              (facilityInstance.actualOutputRate /
                calcRate(outputAmount, recipeNode.recipe.craftingTime));

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

    const outputItemId = getRecipeOutputItemId(plan, nodeId);
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
          ceilMode,
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
        const outputAmount = getOutputAmount(node.recipe, outputItemNode!.item.id);
        const inputDemandRate =
          calcRate(input.amount, node.recipe.craftingTime) *
          (facilityInstance.actualOutputRate /
            calcRate(outputAmount, node.recipe.craftingTime));

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

    // Check if producer's facilities are already processed
    // (byproduct scenario: recipe already has nodes for a primary output)
    const producerAlreadyProcessed =
      producerRecipeId &&
      producerRecipe &&
      poolManager.hasPool(producerRecipeId) &&
      poolManager
        .getFacilityInstances(producerRecipeId)
        .some((f) => poolManager.isProcessed(f.facilityId));

    if (producerAlreadyProcessed && producerRecipeId && producerRecipe) {
      // Byproduct target (terminal or non-terminal): producer facilities
      // already exist for the primary output. Allocate target demand across
      // facilities greedily — only connect enough facilities to satisfy demand.
      // This bypasses pool allocation which only tracks primary output capacity.
      const userTargetRate =
        targetRates?.get(node.itemId) ?? node.productionRate;
      const facilityInstances =
        poolManager.getFacilityInstances(producerRecipeId);
      let remainingDemand = userTargetRate;
      facilityInstances.forEach((fi) => {
        const byproductRate = calcByproductRate(producerRecipe.recipe, node.itemId, fi.actualOutputRate);

        // Allocate only what's needed from this facility
        const allocated = Math.min(byproductRate, remainingDemand);
        if (allocated > 0) {
          edges.push(
            createEdge(
              `e${edgeIdCounter++}`,
              fi.facilityId,
              targetSinkId,
              allocated,
              node.item,
              undefined,
              ceilMode,
              1,
            ),
          );
        }
        remainingDemand -= allocated;

        // Track allocation so disposal pass knows what's left
        byproductAllocatedToTarget.set(`${fi.facilityId}:${node.itemId}`, allocated);
      });

      // Create target sink WITHOUT productionInfo (recipe shown on primary output nodes)
      targetSinkNodes.push(
        createTargetSinkNode(
          targetSinkId,
          node.item,
          userTargetRate,
          items,
          facilities,
          undefined,
          ceilMode,
        ),
      );
    } else if (
      isTerminalTarget &&
      producerRecipe &&
      producerRecipeId &&
      producerRecipe.facilityCount > 1
    ) {
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
            ceilMode,
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
            node.item,
            undefined,
            ceilMode,
          ),
        );

        // Allocate upstream for this facility
        producerRecipe.recipe.inputs.forEach((input) => {
          const outputAmount = getOutputAmount(producerRecipe.recipe, node.itemId);
          const inputDemandRate =
            calcRate(input.amount, producerRecipe.recipe.craftingTime) *
            (facilityInstance.actualOutputRate /
              calcRate(
                outputAmount,
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
          ceilMode,
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
          ceilMode,
        ),
      );

      // Connect dependencies to target sink
      if (producerRecipe && producerRecipeId) {
        if (isTerminalTarget) {
          // Terminal target (single facility): connect recipe inputs directly
          producerRecipe.recipe.inputs.forEach((input) => {
            const outputAmount = getOutputAmount(producerRecipe.recipe, node.itemId);
            const inputDemandRate =
              (input.amount / outputAmount) * userTargetRate;

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

  // Create disposal sink nodes for disposal recipes
  const disposalSinkNodes: FlowDisposalNode[] = [];
  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "recipe" || !node.isDisposal) return;

    const disposalSinkId = `disposal-${nodeId}`;

    // Find the consumed item (edge: item -> disposal recipe)
    const consumedItemId = getRecipeInputItemId(plan, nodeId);
    if (!consumedItemId) return;

    const consumedItemNode = plan.nodes.get(consumedItemId);
    if (!consumedItemNode || consumedItemNode.type !== "item") return;

    const disposalRate =
      calcRate(
        node.recipe.inputs[0].amount,
        node.recipe.craftingTime,
      ) * node.facilityCount;

    disposalSinkNodes.push(
      createDisposalSinkNode(
        disposalSinkId,
        consumedItemNode.item,
        disposalRate,
        node.facility,
        node.facilityCount,
        items,
        facilities,
        ceilMode,
      ),
    );

    // Create edges from producing facilities to disposal sink
    // Find facility instances that produce the waste item
    const producerRecipeId = getNonDisposalProducerRecipeId(plan, consumedItemId);

    if (producerRecipeId && poolManager.hasPool(producerRecipeId)) {
      const facilityInstances =
        poolManager.getFacilityInstances(producerRecipeId);

      // Compute per-facility byproduct rate and subtract target allocation
      const producerRecipeNode = plan.nodes.get(producerRecipeId);

      facilityInstances.forEach((fi) => {
        // Compute this facility's total byproduct output
        let facilityByproductRate: number;
        if (producerRecipeNode?.type === "recipe") {
          facilityByproductRate = calcByproductRate(producerRecipeNode.recipe, consumedItemNode.itemId, fi.actualOutputRate);
        } else {
          facilityByproductRate = disposalRate / facilityInstances.length;
        }

        // Subtract what was already allocated to targets
        const allocatedToTarget =
          byproductAllocatedToTarget.get(`${fi.facilityId}:${consumedItemNode.itemId}`) ?? 0;
        const remaining = facilityByproductRate - allocatedToTarget;

        if (remaining > 0.01) {
          edges.push(
            createEdge(
              `e${edgeIdCounter++}`,
              fi.facilityId,
              disposalSinkId,
              remaining,
              consumedItemNode.item,
              undefined,
              ceilMode,
              1, // Each facility instance is one physical building
            ),
          );
        }
      });
    } else if (producerRecipeId) {
      const producerNode = plan.nodes.get(producerRecipeId);
      const producerFacilityCount =
        producerNode?.type === "recipe" ? producerNode.facilityCount : undefined;
      edges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          producerRecipeId,
          disposalSinkId,
          disposalRate,
          consumedItemNode.item,
          undefined,
          ceilMode,
          producerFacilityCount,
        ),
      );
    }
  });

  return {
    nodes: [...flowNodes, ...targetSinkNodes, ...disposalSinkNodes],
    edges: edges,
  };
}
