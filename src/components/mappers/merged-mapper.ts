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
} from "@/types";
import {
  createEdge,
  createProductionFlowNode,
  createTargetSinkNode,
} from "../flow/flow-utils";
import { createTargetSinkId, createRawMaterialId } from "@/lib/node-keys";
import { calcRate } from "@/lib/utils";

/**
 * Maps a ProductionDependencyGraph to React Flow nodes and edges in merged mode.
 */
export function mapPlanToFlowMerged(
  plan: ProductionDependencyGraph,
  items: Item[],
  facilities: Facility[],
  beltLabel: string,
  targetRates?: Map<ItemId, number>,
  ceilMode = false,
): { nodes: (FlowProductionNode | FlowTargetNode)[]; edges: Edge[] } {
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
      const outputItemId = plan.edges.find((e) => e.from === nodeId)?.to;
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
            {
              isDirectTarget: outputItemNode.isTarget,
              directTargetRate: outputItemNode.isTarget
                ? (targetRates?.get(outputItemNode.itemId) ??
                    outputItemNode.productionRate)
                : undefined,
              ceilMode,
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
      // Find the recipe that produces this item
      const producerRecipeId = Array.from(plan.edges).find(
        (e) => e.to === edge.from && plan.nodes.get(e.from)?.type === "recipe",
      )?.from;

      // Determine where this flow should end
      const outputItemId = plan.edges.find((e) => e.from === edge.to)?.to;
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
            beltLabel,
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
              { isDirectTarget: false, ceilMode },
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
            beltLabel,
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

      const userTargetRate =
        targetRates?.get(node.itemId) ?? node.productionRate;

      targetSinkNodes.push(
        createTargetSinkNode(
          targetNodeId,
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

      // Edge from producer recipe to target sink - only if NOT terminal
      if (producerRecipeId && !isTerminalTarget) {
        flowEdges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            producerRecipeId,
            targetNodeId,
            userTargetRate,
            beltLabel,
            undefined,
            ceilMode,
          ),
        );
      }
    }
  });

  return {
    nodes: [...flowNodes, ...targetSinkNodes] as (
      | FlowProductionNode
      | FlowTargetNode
    )[],
    edges: flowEdges,
  };
}
