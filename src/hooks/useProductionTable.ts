import { useMemo } from "react";
import type {
  PlanMetastorageImport,
  ProductionDependencyGraph,
  ProductionGraphNode,
  ItemId,
  RecipeId,
  BinId,
  Recipe,
} from "@/types";
import type { ProductionLineData } from "@/components/production/ProductionTable";
import { calcRate } from "@/lib/utils";
import { MIN_VISIBLE_RATE_PER_MIN } from "@/lib/flow-thresholds";
import type { BinAggregates } from "@/lib/plan-helpers";
import { getRecipeInputItemId } from "@/lib/plan-helpers";

/**
 * One merged row representing a single (item, active-producer) pair.
 *
 * Items with > 1 active producer (the LP returned a mixed-strategy
 * solution, or two recipes co-produced the same item) get **one
 * MergedRow per producer** rather than a single aggregated row. This
 * mirrors the disposal-row pattern already in the table: distinct
 * recipes touching the same item live on adjacent rows, not folded
 * into one.
 *
 * **Per-producer fields** (different on sister rows for the same item):
 *   - `recipeId` — this row's specific active producer (or `null` for
 *     raw / no-producer items).
 *   - `facilityCount` — this producer's building count only.
 *   - `producerContribution` — this producer's output rate toward the
 *     item, e.g. `output_amount / craftingTime × 60 × facilityCount`.
 *     Sister rows for the same item sum to the item's total output.
 *   - `dependencies` — input items consumed by THIS producer's recipe
 *     only (not the union across sister rows). The hover-highlight
 *     layer in `ProductionTable.tsx` unions sister rows' deps on lookup.
 *
 * **Per-item fields** (identical on every sister row of the same item):
 *   - `isRawMaterial`, `isTarget`, `level`, the underlying `Item` data.
 *
 * Mixed strategies are dormant on current game data (HiGHS simplex
 * returns vertex solutions; no raw caps in the LP today). The shape
 * is in place for the planned raw-cap feature. See `flow-solver.ts:
 * detectMixedStrategies` for runtime DEV telemetry.
 */
type MergedRow = {
  itemId: ItemId;
  recipeId: RecipeId | null;
  facilityCount: number;
  producerContribution: number;
  isRawMaterial: boolean;
  isTarget: boolean;
  dependencies: Set<ItemId>;
  level: number;
  /**
   * Set when this row represents the item's Metastorage-imported
   * supply. Items with both local production and an import get one
   * import row ALONGSIDE their producer rows (sister-row pattern);
   * import-only items get the import row INSTEAD of the empty
   * no-producer row. `producerContribution` carries the import rate.
   */
  metastorageImport?: PlanMetastorageImport;
};

/**
 * Build the per-row merged list from a plan.
 *
 * For each item in `plan.nodes`:
 *   - **Active producers exist** → emit one row per active producer
 *     (`facilityCount > 0`). Each row carries that producer's specific
 *     `facilityCount`, output contribution, and inputs.
 *   - **No active producer** (raw, manual-raw, or chain-terminated) →
 *     emit one row with `recipeId = null`, `facilityCount = 0`. The
 *     row's `producerContribution` falls back to the item's total
 *     production rate (which for raws is the LP-computed net demand).
 *
 * User overrides don't change the row layout: an override pins the LP
 * to one recipe upstream of the table, so by the time `plan` arrives
 * here the override item already has exactly one active producer.
 */
// Exported only for the mixed-strategy unit test in
// `src/tests/lib/merge-item-nodes.test.ts`. Not part of the public hook API.
export function mergeItemNodes(
  plan: ProductionDependencyGraph,
): MergedRow[] {
  // Pre-build O(1) lookups so the per-item loop doesn't rescan edges.
  // `producersByItem`: which active recipes produce each item, with
  // their facility counts (sufficient for the row data).
  // `inputsByRecipe`: which items each recipe consumes (sufficient for
  // per-row dependencies).
  type ActiveProducer = {
    recipeId: RecipeId;
    facilityCount: number;
    contribution: number;
  };
  const producersByItem = new Map<ItemId, ActiveProducer[]>();
  const inputsByRecipe = new Map<RecipeId, ItemId[]>();
  for (const edge of plan.edges) {
    const fromNode = plan.nodes.get(edge.from);
    const toNode = plan.nodes.get(edge.to);
    if (fromNode?.type === "recipe" && toNode?.type === "item") {
      // recipe → item edge (producer relation).
      const fc = fromNode.facilityCount;
      if (fc <= 0) continue;
      const output = fromNode.recipe.outputs.find(
        (o) => o.itemId === toNode.itemId,
      );
      if (!output) continue;
      const contribution = calcRate(output.amount, fromNode.recipe.craftingTime) * fc;
      let list = producersByItem.get(toNode.itemId);
      if (!list) {
        list = [];
        producersByItem.set(toNode.itemId, list);
      }
      list.push({
        recipeId: fromNode.recipeId,
        facilityCount: fc,
        contribution,
      });
    } else if (fromNode?.type === "item" && toNode?.type === "recipe") {
      // item → recipe edge (consumer relation; gives us recipe inputs).
      let list = inputsByRecipe.get(toNode.recipeId);
      if (!list) {
        list = [];
        inputsByRecipe.set(toNode.recipeId, list);
      }
      list.push(fromNode.itemId);
    }
  }

  const rows: MergedRow[] = [];

  // Metastorage imports, grouped by item: each (source, item) becomes
  // one extra sister row (or, for an import-only item, replaces the
  // empty no-producer row) so imported supply is visible next to local
  // production. A list per item because a region can receive the same
  // item from multiple source regions. `MIN_VISIBLE_RATE_PER_MIN`
  // matches the mappers' import-node cutoff so a sub-visible import
  // never yields a table row without a graph node (or vice versa).
  const importsByItem = new Map<ItemId, PlanMetastorageImport[]>();
  for (const imp of plan.metastorageImports) {
    if (imp.ratePerMinute <= MIN_VISIBLE_RATE_PER_MIN) continue;
    const list = importsByItem.get(imp.itemId) ?? [];
    list.push(imp);
    importsByItem.set(imp.itemId, list);
  }

  plan.nodes.forEach((node) => {
    if (node.type !== "item") return;

    const producers = producersByItem.get(node.itemId) ?? [];
    const imports = importsByItem.get(node.itemId) ?? [];

    for (const metastorageImport of imports) {
      rows.push({
        itemId: node.itemId,
        recipeId: null,
        facilityCount: 0,
        producerContribution: metastorageImport.ratePerMinute,
        isRawMaterial: node.isRawMaterial,
        isTarget: node.isTarget,
        dependencies: new Set(),
        level: 0,
        metastorageImport,
      });
    }

    if (producers.length === 0) {
      if (imports.length > 0) return; // import rows replace the empty row
      // Raw / chain-terminator / no-producer item. One row, no recipe.
      rows.push({
        itemId: node.itemId,
        recipeId: null,
        facilityCount: 0,
        producerContribution: node.productionRate,
        isRawMaterial: node.isRawMaterial,
        isTarget: node.isTarget,
        dependencies: new Set(),
        level: 0,
      });
      return;
    }

    for (const producer of producers) {
      const dependencies = new Set<ItemId>(
        inputsByRecipe.get(producer.recipeId) ?? [],
      );
      rows.push({
        itemId: node.itemId,
        recipeId: producer.recipeId,
        facilityCount: producer.facilityCount,
        producerContribution: producer.contribution,
        isRawMaterial: node.isRawMaterial,
        isTarget: node.isTarget,
        dependencies,
        level: 0,
      });
    }
  });

  return rows;
}

/**
 * Compute per-item depth levels and propagate to every row of that
 * item. Levels drive sort order so downstream items (targets) render
 * at the top and raws at the bottom.
 *
 * The dependency set used for level computation is the **union of
 * inputs across all sister rows for the same item** — even though each
 * row only carries its own producer's deps, the item's depth in the
 * chain is determined by its deepest input across any active producer.
 */
function calculateLevels(rows: MergedRow[]): void {
  // Item-level dependency union for the recursion.
  const itemDeps = new Map<ItemId, Set<ItemId>>();
  for (const row of rows) {
    let deps = itemDeps.get(row.itemId);
    if (!deps) {
      deps = new Set();
      itemDeps.set(row.itemId, deps);
    }
    row.dependencies.forEach((d) => deps!.add(d));
  }

  const levels = new Map<ItemId, number>();
  const visited = new Set<ItemId>();

  const calcLevel = (itemId: ItemId): number => {
    if (levels.has(itemId)) return levels.get(itemId)!;
    if (visited.has(itemId)) return 0;
    visited.add(itemId);

    const deps = itemDeps.get(itemId);
    if (!deps || deps.size === 0) {
      levels.set(itemId, 0);
      return 0;
    }

    let maxDepLevel = -1;
    deps.forEach((depItemId) => {
      if (itemDeps.has(depItemId)) {
        maxDepLevel = Math.max(maxDepLevel, calcLevel(depItemId));
      }
    });

    const level = maxDepLevel + 1;
    levels.set(itemId, level);
    return level;
  };

  itemDeps.forEach((_, itemId) => calcLevel(itemId));

  // Propagate the item-level value to every row of that item.
  for (const row of rows) {
    row.level = levels.get(row.itemId) ?? 0;
  }
}

/**
 * Sort rows by level → tier → item id → recipe id.
 *
 * The item-id tiebreaker keeps sister rows (multiple producers of the
 * same item, mixed-strategy case) adjacent in the table; the recipe-id
 * tiebreaker gives a deterministic order within each item's sister
 * group so renders are stable across runs.
 */
function sortRows(
  rows: MergedRow[],
  plan: ProductionDependencyGraph,
): MergedRow[] {
  return [...rows].sort((a, b) => {
    if (b.level !== a.level) return b.level - a.level;
    const itemA = (
      plan.nodes.get(a.itemId) as Extract<ProductionGraphNode, { type: "item" }>
    ).item;
    const itemB = (
      plan.nodes.get(b.itemId) as Extract<ProductionGraphNode, { type: "item" }>
    ).item;
    if (itemB.tier !== itemA.tier) return itemB.tier - itemA.tier;
    if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
    const aRid = a.recipeId ?? "";
    const bRid = b.recipeId ?? "";
    if (aRid !== bRid) return aRid < bRid ? -1 : 1;
    return 0;
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
  manualRawMaterials: Set<ItemId>,
  invalidCycleItemIds: Set<ItemId> = new Set(),
): ProductionTableData {
  return useMemo(() => {
    if (!plan || plan.nodes.size === 0 || !aggregates) {
      return {
        rows: [],
        totals: { totalBuildings: 0, totalPower: 0 },
      };
    }

    const mergedRows = mergeItemNodes(plan);
    calculateLevels(mergedRows);
    const sortedRows = sortRows(mergedRows, plan);

    // Per-bin lookup for bin-aware power amortisation.
    const binById = new Map(plan.bins.map((b) => [b.id, b]));

    const itemRows: ProductionLineData[] = sortedRows.map((row) => {
      const itemNode = plan.nodes.get(row.itemId) as Extract<
        ProductionGraphNode,
        { type: "item" }
      >;

      // Metastorage import row: no recipe picker, no facility — the
      // Recipe column renders a static "Metastorage (region)" label and
      // the Count column a delivery glyph (see ProductionTable.tsx).
      if (row.metastorageImport) {
        return {
          item: itemNode.item,
          outputRate: row.producerContribution,
          availableRecipes: [],
          selectedRecipeId: "" as const,
          facility: null,
          facilityCount: 0,
          isRawMaterial: false,
          isTarget: row.isTarget,
          isManualRawMaterial: false,
          isInvalidCycle: invalidCycleItemIds.has(row.itemId),
          metastorageImport: row.metastorageImport,
        };
      }

      // The dropdown's available-recipes list is the same for every
      // sister row of an item (it's an item-level property). The
      // selected option is the row's own recipe — clicking a different
      // one pins that recipe, which the LP then uses as the SOLE
      // producer of the item (collapsing any mixed strategy to one row
      // on the next recompute).
      const availableRecipes = recipes.filter((recipe) =>
        recipe.outputs.some((output) => output.itemId === row.itemId),
      );

      const selectedRecipeId: RecipeId | "" = row.recipeId ?? "";

      const recipeNode = row.recipeId
        ? (plan.nodes.get(row.recipeId) as
            | Extract<ProductionGraphNode, { type: "recipe" }>
            | undefined)
        : undefined;

      // Bin metadata: when the recipe lives in a multi-formula bin, surface
      // the bin's building count (not raw slots) and mark the alphabetically
      // first recipe of the bin as "primary" — that row displays the bin's
      // full power total; other rows show "grouped" and zero power.
      // `bin.recipeIds` are demand recipe ids (Phase 2's pick), so plain
      // equality with `row.recipeId` resolves correctly even when Phase 3
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
            (rid) => rid !== row.recipeId,
          );
          if (bin.isGrouped) {
            binBuildingCount = bin.buildingCount;
            // bin.recipeIds is already sorted ascending (per packer contract).
            const primaryRecipeId = bin.recipeIds[0];
            isBinPrimary = row.recipeId === primaryRecipeId;
          }
          // Build spanning info from the recipe's allocation across bins.
          // For most plans this is a single-entry array; populated for all
          // grouped recipes so the tooltip can list every bin the recipe
          // is hosted in (handles split allocations).
          if (row.recipeId) {
            const alloc = plan.recipeBinAllocations.get(row.recipeId);
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
        // Per-producer contribution (Option Y): sister rows of a mixed-
        // strategy item each show their own slice; sum across sisters
        // equals the item's total output. For single-producer items
        // (≥ 99% of plans today) this collapses to the item's total
        // output rate — the same value as before the row-per-producer
        // refactor.
        outputRate: row.producerContribution,
        availableRecipes,
        selectedRecipeId,
        facility: recipeNode?.facility || null,
        facilityCount: row.facilityCount,
        isRawMaterial: row.isRawMaterial,
        isTarget: row.isTarget,
        isManualRawMaterial: manualRawMaterials.has(row.itemId),
        isInvalidCycle: invalidCycleItemIds.has(row.itemId),
        directDependencyItemIds: row.dependencies,
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

    // Plan-level totals come from the shared `aggregates` lifted into
    // `useProductionPlan` — same numbers `useProductionStats` consumes,
    // so the table footer and stats panel cannot drift.
    return {
      rows: [...itemRows, ...disposalRows],
      totals: {
        totalBuildings: aggregates.totalBuildings,
        totalPower: aggregates.totalPower,
      },
    };
  }, [plan, aggregates, recipes, manualRawMaterials, invalidCycleItemIds]);
}
