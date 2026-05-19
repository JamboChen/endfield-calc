import type { Node, Edge } from "@xyflow/react";
import type {
  Item,
  ItemId,
  Facility,
  ProductionDependencyGraph,
  ProductionGraphNode,
  FlowNodeData,
  FlowProductionNode,
  FlowTargetNode,
  FlowDisposalNode,
} from "@/types";
import {
  createEdge,
  createProductionFlowNode,
  createTargetSinkNode,
  createDisposalSinkNode,
} from "../flow/flow-utils";
import { createTargetSinkId, createRawMaterialId } from "@/lib/node-keys";
import { calcRate, getRawSourceRate } from "@/lib/utils";
import { rawMaterialSources } from "@/data";
import { MIN_VISIBLE_RATE_PER_MIN } from "@/lib/flow-thresholds";
import { getRecipeOutputItemId, getRecipeInputItemId, getItemProducers, isRecipeTerminal, computeGreedyAllocation } from "@/lib/plan-helpers";
import { assertFlowIntegrity } from "./flow-assertions";

/**
 * Maps a ProductionDependencyGraph to React Flow nodes and edges in merged mode.
 */
export function mapPlanToFlowMerged(
  plan: ProductionDependencyGraph,
  items: Item[],
  facilities: Facility[],
  targetRates?: Map<ItemId, number>,
  ceilMode = false,
): { nodes: (FlowProductionNode | FlowTargetNode | FlowDisposalNode)[]; edges: Edge[] } {
  const flowNodes: Node<FlowNodeData>[] = [];
  const flowEdges: Edge[] = [];
  const targetSinkNodes: FlowTargetNode[] = [];

  let edgeIdCounter = 0;

  // Pre-calculate which items are upstream (have consumers)
  const upstreamItemIds = new Set<string>();
  plan.edges.forEach((edge) => {
    if (plan.nodes.get(edge.from)?.type === "item") {
      upstreamItemIds.add(edge.from);
    }
  });

  // Create production nodes (recipe nodes only)
  plan.nodes.forEach((node, nodeId) => {
    if (node.type === "recipe") {
      const outputItemId = getRecipeOutputItemId(plan, nodeId);
      const outputItemNode = outputItemId
        ? (plan.nodes.get(outputItemId) as
          | Extract<ProductionGraphNode, { type: "item" }>
          | undefined)
        : undefined;

      // Skip recipe node if it's a terminal target (has no consumers and
      // no secondary outputs feeding into other recipes). Multi-output recipes
      // that participate in cycles must NOT be skipped.
      if (outputItemNode && !isRecipeTerminal(plan, nodeId)) {
        // Use per-recipe output rate rather than total item production rate.
        // For single-producer items these are equal; for multi-producer items
        // (e.g. feeder + override both producing the same item) each visual
        // node shows only its own contribution.
        const recipeOutput = node.recipe.outputs.find(
          (o) => o.itemId === outputItemNode.itemId,
        );
        const perRecipeRate = recipeOutput
          ? calcRate(recipeOutput.amount, node.recipe.craftingTime) *
            node.facilityCount
          : outputItemNode.productionRate;

        flowNodes.push(
           createProductionFlowNode(
            nodeId,
            {
              item: outputItemNode.item,
              targetRate: perRecipeRate,
              recipe: node.recipe,
              facility: node.facility,
              facilityCount: node.facilityCount,
              isRawMaterial: false,
              isTarget: outputItemNode.isTarget,
              dependencies: [],
              binId: node.binId,
              binSisterRecipeIds: node.binSisterRecipeIds,
            },
            items,
            facilities,
            ceilMode,
            {
              isDirectTarget: outputItemNode.isTarget,
              directTargetRate: outputItemNode.isTarget
                ? (targetRates?.get(outputItemNode.itemId) ??
                    outputItemNode.productionRate)
                : undefined,
            },
          ),
        );
      }
    }
  });

  // Pre-compute greedy allocation for multi-producer items.
  // Instead of splitting each producer proportionally across all consumers,
  // assigns whole producer outputs to consumers first, minimizing pipe connections.
  // Only applies to items with 2+ non-disposal producers.
  type GreedyResult = {
    consumerEdges: { producerRecipeId: string; consumerId: string; rate: number }[];
    remainingByProducer: Map<string, number>;
  };
  const greedyAllocations = new Map<string, GreedyResult>();

  {
    // Collect all non-disposal consumers per item
    const itemConsumers = new Map<string, { consumerId: string; demand: number }[]>();

    plan.edges.forEach((edge) => {
      const source = plan.nodes.get(edge.from);
      const target = plan.nodes.get(edge.to);
      if (
        source?.type === "item" &&
        target?.type === "recipe" &&
        !target.isDisposal
      ) {
        const inputAmount =
          target.recipe.inputs.find((i) => i.itemId === source.itemId)
            ?.amount || 0;
        const demand =
          calcRate(inputAmount, target.recipe.craftingTime) *
          target.facilityCount;
        if (!itemConsumers.has(edge.from))
          itemConsumers.set(edge.from, []);
        itemConsumers.get(edge.from)!.push({
          consumerId: edge.to,
          demand,
        });
      }
    });

    // Also collect target sink consumers for multi-producer target items
    plan.nodes.forEach((node, nodeId) => {
      if (node.type !== "item" || !node.isTarget || node.isRawMaterial) return;
      const producers = getItemProducers(plan, nodeId);
      if (producers.length <= 1) return;

      const isTerminalTarget = !upstreamItemIds.has(nodeId);
      const anyHasFlowNode = producers.some((p) =>
        flowNodes.some((n) => n.id === p.recipeId),
      );
      if (!isTerminalTarget || anyHasFlowNode) {
        const targetSinkId = createTargetSinkId(node.itemId);
        const userTargetRate =
          targetRates?.get(node.itemId) ?? node.productionRate;
        if (!itemConsumers.has(nodeId)) itemConsumers.set(nodeId, []);
        // Prepend target sink so greedy allocation assigns the primary
        // producer (e.g. the user's override recipe) to the target first,
        // leaving feeder recipes for internal consumers.  This avoids
        // creating visual cycles when a feeder recipe was added.
        itemConsumers.get(nodeId)!.unshift({
          consumerId: targetSinkId,
          demand: userTargetRate,
        });
      }
    });

    // Run greedy allocation for multi-producer items
    itemConsumers.forEach((consumers, itemId) => {
      const producers = getItemProducers(plan, itemId);
      if (producers.length <= 1) return;
      greedyAllocations.set(
        itemId,
        computeGreedyAllocation(producers, consumers),
      );
    });
  }

  // Create edges: Recipe → Item → Recipe
  plan.edges.forEach((edge) => {
    const sourceNode = plan.nodes.get(edge.from);
    const targetNode = plan.nodes.get(edge.to);

    if (!sourceNode || !targetNode) return;

    // Recipe → Item (produce)
    if (sourceNode.type === "recipe" && targetNode.type === "item") {
      // Don't create visible edge, just track the relationship
      return;
    }

    // Item → Recipe (consume)
    if (sourceNode.type === "item" && targetNode.type === "recipe") {
      // Skip disposal recipe edges — disposal sinks create their own edges
      if (targetNode.isDisposal) return;

      // Find ALL recipes that produce this item (handles multi-producer items
      // like liquid_sewage produced by both pool_xiranite_poly_1 and furnace)
      const producers = getItemProducers(plan, edge.from);

      // Determine where this flow should end
      const isTerminalTargetRecipe = isRecipeTerminal(plan, edge.to);

      let flowTargetId = edge.to;
      if (isTerminalTargetRecipe) {
        const outputItemId = getRecipeOutputItemId(plan, edge.to);
        const outputNode = outputItemId ? plan.nodes.get(outputItemId) : undefined;
        if (outputNode?.type === "item") {
          flowTargetId = createTargetSinkId(outputNode.itemId);
        }
      }

      // Calculate total consumption rate
      const inputAmount =
        targetNode.recipe.inputs.find(
          (inp) => inp.itemId === sourceNode.itemId,
        )?.amount || 0;
      const totalFlowRate =
        calcRate(inputAmount, targetNode.recipe.craftingTime) *
        targetNode.facilityCount;

      const greedy = greedyAllocations.get(edge.from);

      if (greedy) {
        // Multi-producer: use pre-computed greedy allocation
        for (const ae of greedy.consumerEdges) {
          if (ae.consumerId !== edge.to) continue;
          if (ae.rate <= MIN_VISIBLE_RATE_PER_MIN) continue;
          flowEdges.push(
            createEdge(
              `e${edgeIdCounter++}`,
              ae.producerRecipeId,
              flowTargetId,
              ae.rate,
              sourceNode.item,
              undefined,
              ceilMode,
            ),
          );
        }
      } else if (producers.length > 0) {
        // Single producer: direct edge at full rate
        flowEdges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            producers[0].recipeId,
            flowTargetId,
            totalFlowRate,
            sourceNode.item,
            undefined,
            ceilMode,
          ),
        );
      } else if (sourceNode.isRawMaterial) {
        // Raw material → Recipe: create node for raw material, tagged
        // with its source facility (unloader_1 / pump_1 / pump_2) and
        // the fractional pickup count. Downstream rendering applies
        // `formatCount(value, ceilMode)` to render ceiled vs fractional.
        // Power for these facilities is summed by `aggregateBinTotals`.
        //
        // Note: this legacy (bf=0) view does NOT route raw byproducts
        // as separate edges. The pickup card's `targetRate` already
        // shows the LP-computed NET external demand
        // (`sourceNode.productionRate`), but the sum of pickup→consumer
        // edges is the GROSS per-consumer demand. Byproduct supply
        // appears on the producing recipe's card but isn't drawn as an
        // edge here. See `mapPlanToFlowBinFused` for the byproduct-
        // routing implementation in the default (bf=1) view.
        const rawMaterialNodeId = createRawMaterialId(sourceNode.itemId);

        if (!flowNodes.find((n) => n.id === rawMaterialNodeId)) {
          const cfg = rawMaterialSources.get(sourceNode.itemId);
          const sourceFacility = cfg
            ? (facilities.find((f) => f.id === cfg.sourceFacility) ?? null)
            : null;
          const perFacilityRate = getRawSourceRate(
            sourceNode.itemId,
            sourceNode.item,
          );
          const pickupCount =
            perFacilityRate > 0
              ? sourceNode.productionRate / perFacilityRate
              : 0;
          flowNodes.push(
            createProductionFlowNode(
              rawMaterialNodeId,
              {
                item: sourceNode.item,
                targetRate: sourceNode.productionRate,
                recipe: null,
                facility: sourceFacility,
                facilityCount: pickupCount,
                isRawMaterial: true,
                isTarget: false,
                dependencies: [],
              },
              items,
              facilities,
              ceilMode,
              { isDirectTarget: false },
            ),
          );
        }

        flowEdges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            rawMaterialNodeId,
            flowTargetId,
            totalFlowRate,
            sourceNode.item,
            undefined,
            ceilMode,
          ),
        );
      }
    }
  });

  // Create target sink nodes
  plan.nodes.forEach((node, nodeId) => {
    if (node.type === "item" && node.isTarget && !node.isRawMaterial) {
      const targetNodeId = createTargetSinkId(node.itemId);

      // Find ALL recipes producing this target item
      const producers = getItemProducers(plan, nodeId);

      const isTerminalTarget = !upstreamItemIds.has(nodeId);

      // Check if ANY producer already has a production flow node
      const anyProducerHasFlowNode = producers.some((p) =>
        flowNodes.some((n) => n.id === p.recipeId),
      );

      const userTargetRate =
        targetRates?.get(node.itemId) ?? node.productionRate;

      // Only embed recipe info in the sink when there's exactly one producer
      // without a separate flow node (terminal target with single recipe)
      const soleProducer =
        producers.length === 1
          ? (plan.nodes.get(producers[0].recipeId) as
              | Extract<ProductionGraphNode, { type: "recipe" }>
              | undefined)
          : undefined;
      const shouldEmbedRecipeInfo = soleProducer && !anyProducerHasFlowNode;

      targetSinkNodes.push(
        createTargetSinkNode(
          targetNodeId,
          node.item,
          userTargetRate,
          items,
          facilities,
          shouldEmbedRecipeInfo
            ? {
                facility: soleProducer.facility,
                facilityCount: soleProducer.facilityCount,
                recipe: soleProducer.recipe,
              }
            : undefined,
          ceilMode,
        ),
      );

      // Edge from producer recipe(s) to target sink:
      // - Always for non-terminal targets
      // - Also for terminal targets when the recipe already has a production node
      //   (byproduct scenario: recipe serves a primary output elsewhere)
      if (producers.length > 0 && (!isTerminalTarget || anyProducerHasFlowNode)) {
        const greedy = greedyAllocations.get(nodeId);

        // Determine which producers contribute and how much
        const edgesToCreate: { producerRecipeId: string; rate: number }[] = [];

        if (greedy) {
          // Multi-producer: use pre-computed greedy allocation
          for (const ae of greedy.consumerEdges) {
            if (ae.consumerId !== targetNodeId) continue;
            if (ae.rate > MIN_VISIBLE_RATE_PER_MIN) {
              edgesToCreate.push({ producerRecipeId: ae.producerRecipeId, rate: ae.rate });
            }
          }
        } else if (producers.length > 0) {
          // Single producer: full target rate
          edgesToCreate.push({ producerRecipeId: producers[0].recipeId, rate: userTargetRate });
        }

        for (const { producerRecipeId, rate: edgeRate } of edgesToCreate) {
          const producerNode = plan.nodes.get(producerRecipeId);
          let edgeFacilityCount: number | undefined;
          if (producerNode?.type === "recipe") {
            const outputEntry = producerNode.recipe.outputs.find(
              (o) => o.itemId === node.itemId,
            );
            if (outputEntry) {
              const ratePerFacility = calcRate(
                outputEntry.amount,
                producerNode.recipe.craftingTime,
              );
              edgeFacilityCount = Math.ceil(edgeRate / ratePerFacility);
            }
          }
          flowEdges.push(
            createEdge(
              `e${edgeIdCounter++}`,
              producerRecipeId,
              targetNodeId,
              edgeRate,
              node.item,
              undefined,
              ceilMode,
              edgeFacilityCount,
            ),
          );
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

    // Defensive: skip phantom sinks below display threshold. The calculator
    // already filters via SURPLUS_EPSILON; this guards against any future
    // path that injects a near-zero disposal recipe and prevents an isolated
    // node from violating flow integrity.
    if (disposalRate <= MIN_VISIBLE_RATE_PER_MIN) return;

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

    // Create edges from producers with remaining output after consumer allocation
    const greedy = greedyAllocations.get(consumedItemId);
    const producers = getItemProducers(plan, consumedItemId);

    for (const producer of producers) {
      // Use greedy remaining if available, otherwise full proportional split
      let edgeRate: number;
      if (greedy) {
        edgeRate = greedy.remainingByProducer.get(producer.recipeId) || 0;
      } else {
        const totalProduction = producers.reduce((sum, p) => sum + p.rate, 0);
        edgeRate =
          totalProduction > 0
            ? disposalRate * (producer.rate / totalProduction)
            : disposalRate;
      }

      if (edgeRate <= MIN_VISIBLE_RATE_PER_MIN) continue;

      // Compute how many facilities of this producer contribute
      const producerNode = plan.nodes.get(producer.recipeId);
      let edgeFacilityCount: number | undefined;
      if (producerNode?.type === "recipe") {
        const outputEntry = producerNode.recipe.outputs.find(
          (o) => o.itemId === consumedItemNode.itemId,
        );
        if (outputEntry) {
          const ratePerFacility = calcRate(
            outputEntry.amount,
            producerNode.recipe.craftingTime,
          );
          edgeFacilityCount = Math.ceil(edgeRate / ratePerFacility);
        }
      }
      flowEdges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          producer.recipeId,
          disposalSinkId,
          edgeRate,
          consumedItemNode.item,
          undefined,
          ceilMode,
          edgeFacilityCount,
        ),
      );
    }
  });

  const allNodes = [...flowNodes, ...targetSinkNodes, ...disposalSinkNodes] as (
    | FlowProductionNode
    | FlowTargetNode
    | FlowDisposalNode
  )[];
  assertFlowIntegrity("merged-mapper", allNodes, flowEdges);
  return { nodes: allNodes, edges: flowEdges };
}
