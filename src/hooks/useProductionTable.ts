import { useMemo } from "react";
import type {
  ProductionDependencyGraph,
  ProductionGraphNode,
  ItemId,
  RecipeId,
  BinId,
  Recipe,
  Facility,
  Item,
} from "@/types";
import type { ProductionLineData } from "@/components/production/ProductionTable";
import { calcRate } from "@/lib/utils";
import { aggregateBinTotals, getRecipeInputItemId } from "@/lib/plan-helpers";

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
  recipeOverrides: Map<ItemId, RecipeId>,
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
      // Find producer recipe. When an item has multiple producers (e.g.,
      // override recipe + feeder recipe), prefer the user's override.
      const overrideId = recipeOverrides.get(node.itemId);
      let producerRecipeId: RecipeId | null = null;

      if (
        overrideId &&
        plan.nodes.has(overrideId) &&
        plan.edges.some(
          (e) => e.from === overrideId && e.to === node.itemId,
        )
      ) {
        producerRecipeId = overrideId;
      } else {
        producerRecipeId =
          Array.from(plan.nodes.values()).find(
            (n): n is Extract<ProductionGraphNode, { type: "recipe" }> =>
              n.type === "recipe" &&
              plan.edges.some(
                (e) => e.from === n.recipeId && e.to === node.itemId,
              ),
          )?.recipeId || null;
      }

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
 * Plan-level totals for the production-table footer. Computed from
 * `plan.bins` directly so split allocations (one recipe spanning
 * multiple bin shapes) are counted correctly. Deriving totals from the
 * row list would undercount whenever the ILP splits a recipe across
 * bins, since each row only carries its first-bin association.
 */
export type PlanTotals = {
  /** Sum of integer building counts across every active bin. */
  totalBuildings: number;
  /** Sum of facility power × buildingCount across every active bin. */
  totalPower: number;
  /**
   * Buildings saved relative to a Reactor-singleton baseline (no
   * grouping). Computed as Σ ceil(slot demand) − Σ bin building count
   * for multi-formula-capable bins. Zero when no grouping happens.
   */
  groupedSavings: number;
};

export type ProductionTableData = {
  rows: ProductionLineData[];
  totals: PlanTotals;
};

/**
 * Hook to generate table data from the production plan.
 */
export function useProductionTable(
  plan: ProductionDependencyGraph | null,
  recipes: Recipe[],
  recipeOverrides: Map<ItemId, RecipeId>,
  manualRawMaterials: Set<ItemId>,
  facilities: Facility[] = [],
  items: Item[] = [],
  invalidCycleItemIds: Set<ItemId> = new Set(),
  ceilMode: boolean = false,
): ProductionTableData {
  return useMemo(() => {
    if (!plan || plan.nodes.size === 0) {
      return {
        rows: [],
        totals: { totalBuildings: 0, totalPower: 0, groupedSavings: 0 },
      };
    }

    const mergedNodes = mergeItemNodes(plan, recipeOverrides);
    calculateLevels(mergedNodes);
    const sortedNodes = sortNodes(mergedNodes, plan);

    // Per-bin lookup for bin-aware power amortisation.
    const binById = new Map(plan.bins.map((b) => [b.id, b]));

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

      // Bin metadata: when the recipe lives in a multi-formula bin, surface
      // the bin's building count (not raw slots) and mark the alphabetically
      // first recipe of the bin as "primary" — that row displays the bin's
      // full power total; other rows show "grouped" and zero power.
      // `bin.recipeIds` are demand recipe ids (Phase 2's pick), so plain
      // equality with `node.recipeId` resolves correctly even when Phase 3
      // swapped the physical variant.
      let binId: BinId | undefined;
      let binSisterRecipeIds: RecipeId[] | undefined;
      let binBuildingCount: number | undefined;
      let isBinPrimary = true; // default for non-grouped: own row owns power
      let binSpanningInfo:
        | Array<{ binId: BinId; buildingCount: number; slots: number }>
        | undefined;
      if (recipeNode?.binId) {
        const bin = binById.get(recipeNode.binId);
        if (bin) {
          binId = bin.id;
          binSisterRecipeIds = bin.recipeIds.filter(
            (rid) => rid !== node.recipeId,
          );
          if (bin.isGrouped) {
            binBuildingCount = bin.buildingCount;
            // bin.recipeIds is already sorted ascending (per packer contract).
            const primaryRecipeId = bin.recipeIds[0];
            isBinPrimary = node.recipeId === primaryRecipeId;
          }
          // Build spanning info from the recipe's allocation across bins.
          // For most plans this is a single-entry array; populated for all
          // grouped recipes so the tooltip can list every bin the recipe
          // is hosted in (handles split allocations).
          if (node.recipeId) {
            const alloc = plan.recipeBinAllocations.get(node.recipeId);
            if (alloc) {
              binSpanningInfo = alloc.perBin
                .map((entry) => {
                  const b = binById.get(entry.binId);
                  return b
                    ? {
                        binId: entry.binId,
                        buildingCount: b.buildingCount,
                        slots: entry.slots,
                      }
                    : null;
                })
                .filter((x): x is NonNullable<typeof x> => x !== null);
            }
          }
        }
      }

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
        isInvalidCycle: invalidCycleItemIds.has(node.itemId),
        directDependencyItemIds: node.dependencies,
        binId,
        binSisterRecipeIds,
        binBuildingCount,
        isBinPrimary,
        binSpanningInfo,
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

    // Plan-level totals come from the shared `aggregateBinTotals` helper
    // in plan-helpers.ts — same numbers `useProductionStats` consumes,
    // so the table footer and stats panel cannot drift. `ceilMode`
    // controls physical-vs-theoretical building/power accounting.
    const aggregates = aggregateBinTotals(plan, facilities, items, {
      ceilMode,
    });
    const groupedSavings = Math.max(
      0,
      aggregates.multiFormulaBaselineBuildings -
        aggregates.multiFormulaActualBuildings,
    );

    return {
      rows: [...itemRows, ...disposalRows],
      totals: {
        totalBuildings: aggregates.totalBuildings,
        totalPower: aggregates.totalPower,
        groupedSavings,
      },
    };
  }, [plan, recipes, recipeOverrides, manualRawMaterials, facilities, items, invalidCycleItemIds, ceilMode]);
}
