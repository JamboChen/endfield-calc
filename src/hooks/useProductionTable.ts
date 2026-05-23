import { useMemo } from "react";
import type {
  ProductionDependencyGraph,
  ProductionGraphNode,
  ItemId,
  RecipeId,
  BinId,
  Recipe,
} from "@/types";
import type { ProductionLineData } from "@/components/production/ProductionTable";
import { calcRate } from "@/lib/utils";
import type { BinAggregates } from "@/lib/plan-helpers";
import { getRecipeInputItemId } from "@/lib/plan-helpers";

/**
 * Per-producer entry in a merged item row. Items with > 1 active producer
 * (the LP returned a mixed-strategy solution, or two recipes co-produced
 * the item as primary + byproduct) get an entry per producer here.
 *
 * **Currently a defensive shape**: with HiGHS simplex on today's data the
 * global LP never returns mixed strategies (HiGHS lands on vertex
 * solutions; no raw-material capacity constraints exist in the LP to
 * force mixing). The structure exists so that when raw caps land
 * (planned future feature) the table renders correctly without a
 * follow-up refactor. See `[MIXED-STRATEGY]` dev-mode log in
 * `flow-solver.ts:detectMixedStrategies` for runtime telemetry.
 */
type ProducerEntry = {
  recipeId: RecipeId;
  facilityCount: number;
};

type MergedItemNode = {
  itemId: ItemId;
  totalProductionRate: number;
  /**
   * Primary producer for the row's dropdown selection. Picked as the
   * dominant (highest facility-count) producer when multiple are active;
   * for the single-producer case (≥ 99% of plans), this is the only
   * producer. Falls back to a user override if one is pinned and active.
   */
  recipeId: RecipeId | null;
  /** All active producers (fc > 0). Length ≥ 2 ⇒ mixed-strategy row. */
  producers: ProducerEntry[];
  /** Sum of facility counts across `producers`. */
  totalFacilityCount: number;
  isRawMaterial: boolean;
  isTarget: boolean;
  dependencies: Set<ItemId>;
  level: number;
};

/**
 * Merges item-level production data into one entry per item. When the LP
 * solution has multiple active producers for the same item (rare but
 * possible under future raw caps — see `ProducerEntry` JSDoc), this
 * function aggregates them: `totalFacilityCount` sums producers, the
 * dropdown's `recipeId` selects the dominant one, and `producers`
 * carries the full breakdown for UI rendering.
 *
 * Producer selection rules:
 *   1. If the user has pinned a recipe via `recipeOverrides` AND that
 *      recipe is an active producer in the plan, use it as primary.
 *      The user's explicit choice always wins the dropdown spot.
 *   2. Otherwise, pick the producer with the highest facility count.
 *   3. Otherwise (no active producer), recipeId = null.
 */
// Exported only for the mixed-strategy unit test in
// `src/tests/lib/merge-item-nodes.test.ts`. Not part of the public hook API.
export function mergeItemNodes(
  plan: ProductionDependencyGraph,
  recipeOverrides: Map<ItemId, RecipeId>,
): Map<ItemId, MergedItemNode> {
  const merged = new Map<ItemId, MergedItemNode>();

  // Pre-build an O(1) item → active producers map so we don't scan
  // `plan.edges` × `plan.nodes` per item (was O(N²) before).
  const producersByItem = new Map<ItemId, ProducerEntry[]>();
  for (const edge of plan.edges) {
    const fromNode = plan.nodes.get(edge.from);
    if (fromNode?.type !== "recipe") continue;
    const toItemId = edge.to as ItemId;
    if (!plan.nodes.has(toItemId)) continue;
    const fc = fromNode.facilityCount;
    if (fc <= 0) continue;
    let list = producersByItem.get(toItemId);
    if (!list) {
      list = [];
      producersByItem.set(toItemId, list);
    }
    list.push({ recipeId: fromNode.recipeId, facilityCount: fc });
  }

  plan.nodes.forEach((node) => {
    if (node.type !== "item") return;

    const existing = merged.get(node.itemId);

    if (existing) {
      // Defensive: items shouldn't appear twice in plan.nodes today, but
      // if they do (e.g. future graph-builder change), merge rates.
      existing.totalProductionRate += node.productionRate;
      if (node.isTarget) existing.isTarget = true;
      return;
    }

    const producers = producersByItem.get(node.itemId) ?? [];

    // Producer selection: user override (if active) > highest-fc producer.
    let producerRecipeId: RecipeId | null = null;
    const overrideId = recipeOverrides.get(node.itemId);
    if (overrideId && producers.some((p) => p.recipeId === overrideId)) {
      producerRecipeId = overrideId;
    } else if (producers.length > 0) {
      let dominant = producers[0];
      for (let i = 1; i < producers.length; i++) {
        if (producers[i].facilityCount > dominant.facilityCount) {
          dominant = producers[i];
        }
      }
      producerRecipeId = dominant.recipeId;
    }

    const totalFacilityCount = producers.reduce(
      (sum, p) => sum + p.facilityCount,
      0,
    );

    // Dependencies = union of inputs across all active producers. Under
    // mixed-strategy this surfaces every upstream item the row depends
    // on, not just the dominant producer's inputs.
    const dependencies = new Set<ItemId>();
    for (const p of producers) {
      for (const edge of plan.edges) {
        if (edge.to !== p.recipeId) continue;
        const sourceNode = plan.nodes.get(edge.from);
        if (sourceNode?.type === "item") {
          dependencies.add(sourceNode.itemId);
        }
      }
    }

    merged.set(node.itemId, {
      itemId: node.itemId,
      totalProductionRate: node.productionRate,
      recipeId: producerRecipeId,
      producers,
      totalFacilityCount,
      isRawMaterial: node.isRawMaterial,
      isTarget: node.isTarget,
      dependencies,
      level: 0,
    });
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
 *
 * `aggregates` is the shared `BinAggregates` computed once in
 * `useProductionPlan` and passed down — eliminates the duplicate
 * `aggregateBinTotals` call this hook used to do.
 */
export function useProductionTable(
  plan: ProductionDependencyGraph | null,
  aggregates: BinAggregates | null,
  recipes: readonly Recipe[],
  recipeOverrides: Map<ItemId, RecipeId>,
  manualRawMaterials: Set<ItemId>,
  invalidCycleItemIds: Set<ItemId> = new Set(),
): ProductionTableData {
  return useMemo(() => {
    if (!plan || plan.nodes.size === 0 || !aggregates) {
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
        // Only surface activeProducers when it's actually multi-producer.
        // Single-producer (the common case) leaves this undefined so the
        // table renders the existing single-recipe layout unchanged.
        activeProducers: node.producers.length > 1 ? node.producers : undefined,
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

    // Plan-level totals come from the shared `aggregates` lifted into
    // `useProductionPlan` — same numbers `useProductionStats` consumes,
    // so the table footer and stats panel cannot drift.
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
  }, [plan, aggregates, recipes, recipeOverrides, manualRawMaterials, invalidCycleItemIds]);
}
