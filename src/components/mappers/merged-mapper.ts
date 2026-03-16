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
import { calcRate } from "@/lib/utils";
import { getRecipeOutputItemId, getRecipeInputItemId, getNonDisposalProducerRecipeId } from "@/lib/plan-helpers";

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

      // Skip recipe node if it's a terminal target (has no consumers)
      // This is because we'll display it in the TargetSinkNode instead
      const isTerminalTarget =
        outputItemNode?.isTarget && !upstreamItemIds.has(outputItemId!);

      if (outputItemNode && !isTerminalTarget) {
        flowNodes.push(
           createProductionFlowNode(
            nodeId,
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

      // Find the recipe that produces this item
      const producerRecipeId = Array.from(plan.edges).find(
        (e) => e.to === edge.from && plan.nodes.get(e.from)?.type === "recipe",
      )?.from;

      // Determine where this flow should end
      const outputItemId = getRecipeOutputItemId(plan, edge.to);
      const outputNode = outputItemId ? plan.nodes.get(outputItemId) : undefined;
      const isTerminalTargetRecipe =
        outputItemId &&
        outputNode?.type === "item" &&
        outputNode.isTarget &&
        !upstreamItemIds.has(outputItemId);

      const flowTargetId =
        isTerminalTargetRecipe && outputNode?.type === "item"
          ? createTargetSinkId(outputNode.itemId)
          : edge.to;

      if (producerRecipeId) {
        // Calculate flow rate
        const inputAmount =
          targetNode.recipe.inputs.find(
            (inp) => inp.itemId === sourceNode.itemId,
          )?.amount || 0;
        const flowRate =
          calcRate(inputAmount, targetNode.recipe.craftingTime) *
          targetNode.facilityCount;

        flowEdges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            producerRecipeId,
            flowTargetId,
            flowRate,
            sourceNode.item,
            undefined,
            ceilMode,
          ),
        );
      } else if (sourceNode.isRawMaterial) {
        // Raw material → Recipe: create node for raw material
        const rawMaterialNodeId = createRawMaterialId(sourceNode.itemId);

        if (!flowNodes.find((n) => n.id === rawMaterialNodeId)) {
          flowNodes.push(
            createProductionFlowNode(
              rawMaterialNodeId,
              {
                item: sourceNode.item,
                targetRate: sourceNode.productionRate,
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
              { isDirectTarget: false },
            ),
          );
        }

        const inputAmount =
          targetNode.recipe.inputs.find(
            (inp) => inp.itemId === sourceNode.itemId,
          )?.amount || 0;
        const flowRate =
          calcRate(inputAmount, targetNode.recipe.craftingTime) *
          targetNode.facilityCount;

        flowEdges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            rawMaterialNodeId,
            flowTargetId,
            flowRate,
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

      // Find the recipe producing this target
      const producerRecipeId = Array.from(plan.edges).find(
        (e) => e.to === nodeId && plan.nodes.get(e.from)?.type === "recipe",
      )?.from;

      const producerRecipe = producerRecipeId
        ? (plan.nodes.get(producerRecipeId) as
          | Extract<ProductionGraphNode, { type: "recipe" }>
          | undefined)
        : undefined;

      const isTerminalTarget = !upstreamItemIds.has(nodeId);

      // Check if the producer recipe already has a production flow node
      // (e.g., the recipe also produces a primary non-byproduct output)
      const producerHasFlowNode = producerRecipeId
        ? flowNodes.some((n) => n.id === producerRecipeId)
        : false;

      const userTargetRate =
        targetRates?.get(node.itemId) ?? node.productionRate;

      // Only embed recipe info in the sink when no separate production node exists
      const shouldEmbedRecipeInfo = producerRecipe && !producerHasFlowNode;

      targetSinkNodes.push(
        createTargetSinkNode(
          targetNodeId,
          node.item,
          userTargetRate,
          items,
          facilities,
          shouldEmbedRecipeInfo
            ? {
              facility: producerRecipe.facility,
              facilityCount: producerRecipe.facilityCount,
              recipe: producerRecipe.recipe,
            }
            : undefined,
          ceilMode,
        ),
      );

      // Edge from producer recipe to target sink:
      // - Always for non-terminal targets
      // - Also for terminal targets when the recipe already has a production node
      //   (byproduct scenario: recipe serves a primary output elsewhere)
      if (producerRecipeId && (!isTerminalTarget || producerHasFlowNode)) {
        // Compute how many facilities actually contribute to this edge flow,
        // not the total recipe facility count
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
            edgeFacilityCount = Math.ceil(userTargetRate / ratePerFacility);
          }
        }
        flowEdges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            producerRecipeId,
            targetNodeId,
            userTargetRate,
            node.item,
            undefined,
            ceilMode,
            edgeFacilityCount,
          ),
        );
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

    // Find the producer recipe of the consumed item to create an edge
    const producerRecipeId = getNonDisposalProducerRecipeId(plan, consumedItemId);

    if (producerRecipeId) {
      // Compute how many facilities contribute to this disposal flow
      const producerNode = plan.nodes.get(producerRecipeId);
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
          edgeFacilityCount = Math.ceil(disposalRate / ratePerFacility);
        }
      }
      flowEdges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          producerRecipeId,
          disposalSinkId,
          disposalRate,
          consumedItemNode.item,
          undefined,
          ceilMode,
          edgeFacilityCount,
        ),
      );
    }
  });

  return {
    nodes: [...flowNodes, ...targetSinkNodes, ...disposalSinkNodes] as (
      | FlowProductionNode
      | FlowTargetNode
      | FlowDisposalNode
    )[],
    edges: flowEdges,
  };
}
