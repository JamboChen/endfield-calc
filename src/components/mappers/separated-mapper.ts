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
import { getRecipeOutputItemId, getRecipeInputItemId, getItemProducers, isRecipeTerminal } from "@/lib/plan-helpers";
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

  // Pre-build SCC cycle recipe pairs for backward edge detection.
  // Two recipes are "cycle partners" if they appear in the same detected SCC.
  const cyclePairs = new Set<string>();
  plan.detectedCycles.forEach((cycle) => {
    const recipeIds = cycle.cycleNodes
      .filter((cn) => cn.recipe !== null)
      .map((cn) => cn.recipe!.id);
    for (const a of recipeIds) {
      for (const b of recipeIds) {
        if (a !== b) cyclePairs.add(`${a}:${b}`);
      }
    }
  });

  /** Extract recipe ID from a facility instance ID ("recipeId-f0" → "recipeId") */
  function getRecipeIdFromFacilityId(facilityId: string): string | null {
    const match = facilityId.match(/^(.+)-f\d+$/);
    return match ? match[1] : null;
  }

  /** Check if producer and consumer recipes are in the same SCC cycle */
  function isInSameCycle(
    producerRecipeId: string,
    consumerFacilityId: string,
  ): boolean {
    const consumerRecipeId = getRecipeIdFromFacilityId(consumerFacilityId);
    if (!consumerRecipeId) return false;
    return cyclePairs.has(`${producerRecipeId}:${consumerRecipeId}`);
  }

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
        // Use per-recipe output rate, not the total item production rate.
        // For multi-producer items (e.g. liquid_sewage produced by both
        // pool_xiranite_poly_1 and furnace), the total item productionRate
        // includes contributions from all producers. Each pool should only
        // represent THIS recipe's production — matching the merged mapper.
        const recipeOutput = node.recipe.outputs.find(
          (o) => o.itemId === outputItemId,
        );
        const perRecipeRate = recipeOutput
          ? calcRate(recipeOutput.amount, node.recipe.craftingTime) *
            node.facilityCount
          : outputItemNode.productionRate;

        poolManager.createPool(
          {
            item: outputItemNode.item,
            targetRate: perRecipeRate,
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

    // Find ALL producer recipes with their production rates.
    const producers = getItemProducers(plan, itemId);

    if (producers.length === 0) {
      // Raw material — create pickup point nodes and allocate
      ensurePickupPointNodes(itemId, itemNode.item, itemNode.productionRate);
      allocateFromPickupPoints(itemId, itemNode.item, demandRate, consumerFacilityId);
      return;
    }

    // Greedy cascade: fill demand from one producer before moving to the next.
    // This produces whole-facility assignments and minimizes pipe connections,
    // unlike proportional split which sends fractional amounts to every producer.
    // Sort by rate descending so large producers are assigned first.
    const sorted = [...producers].sort((a, b) => b.rate - a.rate);

    let remainingDemand = demandRate;

    for (const producer of sorted) {
      if (remainingDemand <= 0.001) break;

      const isBackward = isInSameCycle(producer.recipeId, consumerFacilityId);
      const toAllocate = Math.min(remainingDemand, producer.rate);

      const actuallyAllocated = allocateFromPool(
        producer.recipeId,
        toAllocate,
        consumerFacilityId,
        isBackward ? "backward" : undefined,
        itemId,
      );

      // Use actual allocation, not the requested amount. When backward
      // byproduct allocation returns less than requested (e.g., cycle
      // producer's byproduct capacity exhausted), the remaining demand
      // must flow to the next producer (the external source).
      remainingDemand -= actuallyAllocated;
    }
  }

  /**
   * @returns The total amount actually allocated (in demanded-item units),
   *   which may be less than demandRate if the pool is depleted.
   */
  function allocateFromPool(
    recipeId: string,
    demandRate: number,
    consumerFacilityId: string,
    edgeDirection?: "backward",
    demandedItemId?: string,
  ): number {
    if (!poolManager.hasPool(recipeId)) {
      console.warn(`Pool not found for ${recipeId}`);
      return 0;
    }

    const recipeNode = plan.nodes.get(recipeId) as Extract<
      ProductionGraphNode,
      { type: "recipe" }
    >;
    const primaryOutputId = getRecipeOutputItemId(plan, recipeId);
    const primaryOutputNode = primaryOutputId
      ? (plan.nodes.get(primaryOutputId) as
          | Extract<ProductionGraphNode, { type: "item" }>
          | undefined)
      : undefined;

    if (!recipeNode || !primaryOutputNode) return 0;

    // Determine the item actually being demanded (for edge display).
    // Falls back to primary output when demandedItemId is not specified
    // (e.g., when called from the main loop or target sink pass).
    const demandedNode = demandedItemId
      ? (plan.nodes.get(demandedItemId) as
          | Extract<ProductionGraphNode, { type: "item" }>
          | undefined)
      : undefined;
    const edgeItem = demandedNode?.item ?? primaryOutputNode.item;

    // When the demanded item is a byproduct (not the primary output),
    // convert the demand rate to pool units (primary output denomination).
    // Pool capacity is tracked in primary output units, so byproduct demands
    // must be converted to avoid over/under-allocation.
    const isByproductDemand =
      demandedItemId && demandedItemId !== primaryOutputId;
    let poolDemandRate = demandRate;
    let conversionRatio = 1; // byproduct-to-primary ratio for converting back

    if (isByproductDemand) {
      const byproductAmount =
        recipeNode.recipe.outputs.find((o) => o.itemId === demandedItemId)
          ?.amount || 0;
      const primaryAmount =
        recipeNode.recipe.outputs.find((o) => o.itemId === primaryOutputId)
          ?.amount || 0;

      if (byproductAmount > 0 && primaryAmount > 0) {
        conversionRatio = byproductAmount / primaryAmount;
        poolDemandRate = demandRate / conversionRatio;
      }
    }

    // For byproduct demands, first allocate from already-consumed capacity
    // (facilities running for their primary output produce byproducts for free).
    // Then fall through to regular allocate() for any remaining demand to
    // activate new facility instances if needed.
    let allocations: { sourceNodeId: string; allocatedAmount: number; fromFacilityIndex: number }[];

    if (isByproductDemand && demandedItemId) {
      if (edgeDirection === "backward") {
        // Backward cycle edges: allocate ONLY from byproduct (never consume
        // primary capacity). Use forceRunning because the SCC solver has
        // already determined these facilities will run — their byproduct is
        // guaranteed even if the facility hasn't been visited yet in this
        // mapper pass. This prevents the double-allocation bug where backward
        // Sewage allocation consumed pool_xiranite's Xircon capacity.
        allocations = poolManager.allocateByproduct(
          recipeId,
          poolDemandRate,
          demandedItemId,
          true,
        );
      } else {
        // Forward byproduct demand (non-cycle): try free byproduct first,
        // then fall through to regular allocate for any remainder.
        allocations = poolManager.allocateByproduct(
          recipeId,
          poolDemandRate,
          demandedItemId,
        );

        const satisfiedPrimary = allocations.reduce(
          (sum, a) => sum + a.allocatedAmount,
          0,
        );
        const remainingPrimary = poolDemandRate - satisfiedPrimary;

        if (remainingPrimary > 0.001) {
          // Some facilities haven't been activated yet — allocate normally
          // to trigger their first-visit processing
          const additional = poolManager.allocate(recipeId, remainingPrimary);
          allocations = allocations.concat(additional);
        }
      }
    } else {
      allocations = poolManager.allocate(recipeId, poolDemandRate);
    }

    allocations.forEach((allocation) => {
      // Convert allocated amount back to demanded item units for edge display
      const edgeRate = allocation.allocatedAmount * conversionRatio;

      edges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          allocation.sourceNodeId,
          consumerFacilityId,
          edgeRate,
          edgeItem,
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

          // Create facility node — always displays the primary output
          flowNodes.push(
            createProductionFlowNode(
              allocation.sourceNodeId,
              {
                item: primaryOutputNode.item,
                targetRate: facilityInstance.actualOutputRate,
                recipe: recipeNode.recipe,
                facility: recipeNode.facility,
                facilityCount: 1,
                isRawMaterial: false,
                isTarget: primaryOutputNode.isTarget,
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

          // Allocate upstream inputs based on primary output rate
          // (inputs scale with recipe execution rate, not byproduct rate)
          recipeNode.recipe.inputs.forEach((input) => {
            const outputAmount = getOutputAmount(
              recipeNode.recipe,
              primaryOutputNode.item.id,
            );
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

    // Return total actually allocated in demanded-item units
    return allocations.reduce(
      (sum, a) => sum + a.allocatedAmount * conversionRatio,
      0,
    );
  }

  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "recipe") return;

    const outputItemId = getRecipeOutputItemId(plan, nodeId);
    const outputItemNode = outputItemId
      ? (plan.nodes.get(outputItemId) as
          | Extract<ProductionGraphNode, { type: "item" }>
          | undefined)
      : undefined;

    // Skip recipes handled by the target sink pass. Only skip truly terminal
    // recipes — multi-output recipes with secondary outputs consumed by other
    // recipes (e.g., pool_xiranite_poly_1) must be processed here.
    if (!outputItemNode || isRecipeTerminal(plan, nodeId)) return;

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

    // Create edges from ALL producing facilities to disposal sink
    const producers = getItemProducers(plan, consumedItemId);

    for (const producer of producers) {
      if (poolManager.hasPool(producer.recipeId)) {
        const facilityInstances =
          poolManager.getFacilityInstances(producer.recipeId);

        // Compute per-facility byproduct rate and subtract target allocation
        const producerRecipeNode = plan.nodes.get(producer.recipeId);

        facilityInstances.forEach((fi) => {
          let facilityByproductRate: number;
          if (producerRecipeNode?.type === "recipe") {
            facilityByproductRate = calcByproductRate(
              producerRecipeNode.recipe,
              consumedItemNode.itemId,
              fi.actualOutputRate,
            );
          } else {
            facilityByproductRate = disposalRate / facilityInstances.length;
          }

          // Subtract what was already allocated to targets
          const allocatedToTarget =
            byproductAllocatedToTarget.get(
              `${fi.facilityId}:${consumedItemNode.itemId}`,
            ) ?? 0;
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
                1,
              ),
            );
          }
        });
      } else {
        const producerNode = plan.nodes.get(producer.recipeId);
        const producerFacilityCount =
          producerNode?.type === "recipe"
            ? producerNode.facilityCount
            : undefined;
        edges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            producer.recipeId,
            disposalSinkId,
            producer.rate,
            consumedItemNode.item,
            undefined,
            ceilMode,
            producerFacilityCount,
          ),
        );
      }
    }
  });

  return {
    nodes: [...flowNodes, ...targetSinkNodes, ...disposalSinkNodes],
    edges: edges,
  };
}
