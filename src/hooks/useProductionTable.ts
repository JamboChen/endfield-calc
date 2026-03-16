import { useMemo } from "react";
import type {
  ProductionDependencyGraph,
  ProductionGraphNode,
  ItemId,
  RecipeId,
  Recipe,
} from "@/types";
import type { ProductionLineData } from "@/components/production/ProductionTable";
import { calcRate } from "@/lib/utils";
import { getRecipeInputItemId } from "@/lib/plan-helpers";

type MergedItemNode = {
  itemId: ItemId;
  totalProductionRate: number;
  recipeId: RecipeId | null;
  totalFacilityCount: number;
  isRawMaterial: boolean;
  isTarget: boolean;
  dependencies: Set<ItemId>;
  level: number;
};

/**
 * Merges production data for items that are produced by same recipe.
 */
function mergeItemNodes(
  plan: ProductionDependencyGraph,
): Map<ItemId, MergedItemNode> {
  const merged = new Map<ItemId, MergedItemNode>();

  plan.nodes.forEach((node) => {
    if (node.type !== "item") return;

    const existing = merged.get(node.itemId);

    if (existing) {
      // Merge rates (shouldn't happen in current implementation, but safe)
      existing.totalProductionRate += node.productionRate;
      if (node.isTarget) existing.isTarget = true;
    } else {
      // Find producer recipe
      const producerRecipeId =
        Array.from(plan.nodes.values()).find(
          (n): n is Extract<ProductionGraphNode, { type: "recipe" }> =>
            n.type === "recipe" &&
            plan.edges.some(
              (e) => e.from === n.recipeId && e.to === node.itemId,
            ),
        )?.recipeId || null;

      const facilityCount = producerRecipeId
        ? (
            plan.nodes.get(producerRecipeId) as Extract<
              ProductionGraphNode,
              { type: "recipe" }
            >
          )?.facilityCount || 0
        : 0;

      // Find dependencies (items consumed by this item's producer recipe)
      const dependencies = new Set<ItemId>();
      if (producerRecipeId) {
        plan.edges.forEach((edge) => {
          if (edge.to === producerRecipeId) {
            const sourceNode = plan.nodes.get(edge.from);
            if (sourceNode?.type === "item") {
              dependencies.add(sourceNode.itemId);
            }
          }
        });
      }

      merged.set(node.itemId, {
        itemId: node.itemId,
        totalProductionRate: node.productionRate,
        recipeId: producerRecipeId,
        totalFacilityCount: facilityCount,
        isRawMaterial: node.isRawMaterial,
        isTarget: node.isTarget,
        dependencies,
        level: 0,
      });
    }
  });

  return merged;
}

/**
 * Calculates depth levels using topological order.
 */
function calculateLevels(merged: Map<ItemId, MergedItemNode>): void {
  const levels = new Map<ItemId, number>();
  const visited = new Set<ItemId>();

  const calcLevel = (itemId: ItemId): number => {
    if (levels.has(itemId)) return levels.get(itemId)!;
    if (visited.has(itemId)) return 0;

    visited.add(itemId);

    const node = merged.get(itemId);
    if (!node || node.dependencies.size === 0) {
      levels.set(itemId, 0);
      return 0;
    }

    let maxDepLevel = -1;
    node.dependencies.forEach((depItemId) => {
      if (merged.has(depItemId)) {
        maxDepLevel = Math.max(maxDepLevel, calcLevel(depItemId));
      }
    });

    const level = maxDepLevel + 1;
    levels.set(itemId, level);
    node.level = level;
    return level;
  };

  merged.forEach((_, itemId) => calcLevel(itemId));
}

/**
 * Sorts merged nodes by level and tier.
 */
function sortNodes(
  merged: Map<ItemId, MergedItemNode>,
  plan: ProductionDependencyGraph,
): MergedItemNode[] {
  const nodes = Array.from(merged.values());

  return nodes.sort((a, b) => {
    if (b.level !== a.level) {
      return b.level - a.level;
    }
    const itemA = (
      plan.nodes.get(a.itemId) as Extract<ProductionGraphNode, { type: "item" }>
    ).item;
    const itemB = (
      plan.nodes.get(b.itemId) as Extract<ProductionGraphNode, { type: "item" }>
    ).item;
    return itemB.tier - itemA.tier;
  });
}

/**
 * Hook to generate table data from the production plan.
 */
export function useProductionTable(
  plan: ProductionDependencyGraph | null,
  recipes: Recipe[],
  recipeOverrides: Map<ItemId, RecipeId>,
  manualRawMaterials: Set<ItemId>,
): ProductionLineData[] {
  return useMemo(() => {
    if (!plan || plan.nodes.size === 0) {
      return [];
    }

    const mergedNodes = mergeItemNodes(plan);
    calculateLevels(mergedNodes);
    const sortedNodes = sortNodes(mergedNodes, plan);

    const itemRows: ProductionLineData[] = sortedNodes.map((node) => {
      const itemNode = plan.nodes.get(node.itemId) as Extract<
        ProductionGraphNode,
        { type: "item" }
      >;

      const availableRecipes = recipes.filter((recipe) =>
        recipe.outputs.some((output) => output.itemId === node.itemId),
      );

      let selectedRecipeId: RecipeId | "" = "";
      if (recipeOverrides.has(node.itemId)) {
        selectedRecipeId = recipeOverrides.get(node.itemId)!;
      } else if (node.recipeId) {
        selectedRecipeId = node.recipeId;
      }

      const recipeNode = node.recipeId
        ? (plan.nodes.get(node.recipeId) as
            | Extract<ProductionGraphNode, { type: "recipe" }>
            | undefined)
        : undefined;

      return {
        item: itemNode.item,
        outputRate: node.totalProductionRate,
        availableRecipes,
        selectedRecipeId,
        facility: recipeNode?.facility || null,
        facilityCount: node.totalFacilityCount,
        isRawMaterial: node.isRawMaterial,
        isTarget: node.isTarget,
        isManualRawMaterial: manualRawMaterials.has(node.itemId),
        directDependencyItemIds: node.dependencies,
      };
    });

    // Add disposal rows for disposal recipes
    const disposalRows: ProductionLineData[] = [];
    plan.nodes.forEach((node) => {
      if (node.type !== "recipe" || !node.isDisposal) return;

      // Find the consumed item
      const consumedItemId = getRecipeInputItemId(plan, node.recipeId);
      if (!consumedItemId) return;

      const consumedItemNode = plan.nodes.get(consumedItemId);
      if (!consumedItemNode || consumedItemNode.type !== "item") return;

      const disposalRate =
        calcRate(node.recipe.inputs[0].amount, node.recipe.craftingTime) *
        node.facilityCount;

      disposalRows.push({
        item: consumedItemNode.item,
        outputRate: disposalRate,
        availableRecipes: [node.recipe],
        selectedRecipeId: node.recipeId,
        facility: node.facility,
        facilityCount: node.facilityCount,
        isRawMaterial: false,
        isTarget: false,
        isDisposal: true,
      });
    });

    return [...itemRows, ...disposalRows];
  }, [plan, recipes, recipeOverrides, manualRawMaterials]);
}
