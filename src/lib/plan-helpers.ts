import type {
  ProductionDependencyGraph,
  ProductionGraphNode,
  ProductionNode,
  Bin,
  BinId,
  Facility,
  FacilityId,
  ItemId,
  RecipeId,
  Item,
  Recipe,
} from "@/types";
import { calcRate, getRawSourceRate } from "@/lib/utils";
import { MIN_VISIBLE_RATE_PER_MIN } from "@/lib/flow-thresholds";
import { rawMaterialSources } from "@/data";

/**
 * Bin-level plan aggregates derived from `plan.bins`. Single
 * source of truth for "how many physical buildings", "how much power",
 * and "what's the per-facility breakdown" — consumed by both
 * `useProductionStats` (the side-panel statistics card) and
 * `useProductionTable` (the table footer totals).
 *
 * Keeping both hooks anchored to the same aggregator prevents the two
 * from drifting (which is what produced the "Expanded Crucible: 3" bug
 * at Xircon target=6 — the stats hook used to count per-recipe-ceiled
 * `node.facilityCount` and triple-counted shared bins).
 *
 * The aggregator accepts a `ceilMode` flag that toggles between
 * "physical" (whole buildings, full power per built building) and
 * "theoretical" (fractional buildings, proportional power) views.
 * Mode-dependent fields: `totalBuildings`, `totalPower`, `perFacility`.
 * Mode-independent fields: `multiFormulaActualBuildings` and
 * `multiFormulaBaselineBuildings` always count whole buildings — the
 * "buildings saved" metric they feed is only physically meaningful at
 * the integer level.
 */
export type BinAggregates = {
  /**
   * Σ effective bin building count across every bin.
   * - `ceilMode=true`: Σ `Math.max(1, Math.ceil(bin.buildingCount))`.
   * - `ceilMode=false`: Σ `mean(recipe activities in bin)` — the bin's
   *   sum of per-recipe slot allocations divided by recipe count.
   *   For singletons this collapses to `bin.buildingCount`; for grouped
   *   bins it's strictly ≤ `bin.buildingCount`.
   */
  totalBuildings: number;
  /**
   * Σ `facility.powerConsumption × effective buildings` across bins.
   * - `ceilMode=true`: each built (ceiled) building pays full power.
   * - `ceilMode=false`: power scales with the bin's mean activity — a
   *   half-utilised grouped bin draws half its physical power
   *   complement.
   */
  totalPower: number;
  /**
   * Per-facility-id sum of effective building counts. Same ceilMode
   * semantics as `totalBuildings`. One entry per facility hosting at
   * least one bin. Used by the stats panel's per-facility breakdown.
   */
  perFacility: Map<FacilityId, number>;
  /**
   * Σ `Math.max(1, Math.ceil(bin.buildingCount))` for bins on
   * multi-formula-eligible facilities (those with `cacheSlots` defined).
   * Always ceiled — this is the "physically built multi-formula
   * buildings" counterfactual half of the groupedSavings calculation.
   */
  multiFormulaActualBuildings: number;
  /**
   * Σ `Math.ceil(node.facilityCount)` over recipe nodes hosted on
   * multi-formula-eligible facilities — i.e. "what would total be if
   * every recipe ran in its own building, no grouping". Always ceiled
   * (physical counterfactual). Subtracting `multiFormulaActualBuildings`
   * from this gives groupedSavings.
   */
  multiFormulaBaselineBuildings: number;
};

/**
 * Build a per-bin sum of recipe slot activities from
 * `plan.recipeBinAllocations`. Used by the ceilMode=OFF branch of
 * `aggregateBinTotals` and by the bin-fused-mapper's merged path to
 * report each grouped bin's mean activity rather than the integer
 * physical `buildingCount`.
 *
 * For singleton bins this returns `bin.buildingCount` (one recipe → one
 * entry equals the bin's own count). For grouped bins it's the sum of
 * per-recipe slot allocations the greedy allocator drained into this
 * bin, which is bounded above by `recipeCount × bin.buildingCount`.
 */
export function buildBinActivitySums(
  plan: ProductionDependencyGraph,
): Map<BinId, number> {
  const sumByBin = new Map<BinId, number>();
  for (const alloc of plan.recipeBinAllocations.values()) {
    for (const entry of alloc.perBin) {
      sumByBin.set(
        entry.binId,
        (sumByBin.get(entry.binId) ?? 0) + entry.slots,
      );
    }
  }
  return sumByBin;
}

/**
 * Aggregate `plan.bins` into building / power / per-facility
 * counts. Pure function; both `useProductionStats` and
 * `useProductionTable` call this so they cannot drift.
 *
 * `options.ceilMode` controls the rounding semantic:
 *   - `true` (physical view): each bin contributes
 *     `Math.max(1, Math.ceil(bin.buildingCount))` buildings, and pays
 *     full power per ceiled building. A tiny 0.05-building Purifier
 *     counts as 1 building drawing 50W (its full rating).
 *   - `false` (theoretical / mean-activity view): each bin contributes
 *     the **mean** of its constituent recipes' active slot allocations
 *     (`sum_activities / recipe_count`). For singleton bins this
 *     reduces to `bin.buildingCount` (no change). For grouped bins it
 *     surfaces partial-load information that the integer bin count
 *     hides — a `{LX, XE, X}` bin with activities (2, 2, 1.9) shows
 *     `5.9 / 3 ≈ 1.967` instead of `2`. By construction
 *     `mean ≤ bin.buildingCount`, so ceilMode=OFF values never exceed
 *     ceilMode=ON values.
 *
 * `multiFormulaActualBuildings` and `multiFormulaBaselineBuildings`
 * are always ceiled regardless of `ceilMode` — they represent
 * physical building counts in the "savings vs no-grouping baseline"
 * comparison, which only makes sense as integers.
 *
 * `multiFormulaBaselineBuildings` iterates production-graph recipe
 * nodes (not item nodes) so each recipe contributes once even when
 * multiple recipes co-produce an item or feeders are added by the SCC
 * solver.
 */
export function aggregateBinTotals(
  plan: ProductionDependencyGraph,
  facilities: Facility[],
  items: Item[],
  options: { ceilMode?: boolean } = {},
): BinAggregates {
  const { ceilMode = false } = options;
  const facilityById = new Map(facilities.map((f) => [f.id, f] as const));
  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const sumByBin = buildBinActivitySums(plan);

  let totalBuildings = 0;
  let totalPower = 0;
  let multiFormulaActualBuildings = 0;
  const perFacility = new Map<FacilityId, number>();

  for (const bin of plan.bins) {
    const facility = facilityById.get(bin.facilityId);
    if (!facility) continue;
    const ceiledBuildings = Math.max(1, Math.ceil(bin.buildingCount));
    const recipeCount = Math.max(1, bin.recipeIds.length);
    const sumActivities = sumByBin.get(bin.id) ?? bin.buildingCount;
    const meanActivity = sumActivities / recipeCount;
    const effectiveBuildings = ceilMode ? ceiledBuildings : meanActivity;
    totalBuildings += effectiveBuildings;
    totalPower += facility.powerConsumption * effectiveBuildings;
    perFacility.set(
      facility.id,
      (perFacility.get(facility.id) ?? 0) + effectiveBuildings,
    );
    if (facility.cacheSlots != null) {
      // Always-ceiled — groupedSavings is a physical-buildings comparison.
      multiFormulaActualBuildings += ceiledBuildings;
    }
  }

  // Fold pickup-point source facilities (unloader_1, pump_1, pump_2)
  // into the totals so the table footer / stats panel show source-
  // facility counts and power alongside production facilities. Pickup
  // counts are always ceiled (physical buildings) regardless of
  // `ceilMode` — there's no "fractional pump" semantic.
  for (const node of plan.nodes.values()) {
    if (node.type !== "item") continue;
    if (!node.isRawMaterial) continue;
    if (node.productionRate <= 0) continue;
    const cfg = rawMaterialSources.get(node.itemId);
    if (!cfg) continue;
    const facility = facilityById.get(cfg.sourceFacility);
    if (!facility) continue;
    const item = itemById.get(node.itemId);
    const perFacilityRate = getRawSourceRate(node.itemId, item);
    if (perFacilityRate <= 0) continue;
    const pickupCount = Math.ceil(node.productionRate / perFacilityRate);
    totalBuildings += pickupCount;
    totalPower += facility.powerConsumption * pickupCount;
    perFacility.set(
      facility.id,
      (perFacility.get(facility.id) ?? 0) + pickupCount,
    );
  }

  let multiFormulaBaselineBuildings = 0;
  plan.nodes.forEach((node) => {
    if (node.type !== "recipe") return;
    if (node.facility?.cacheSlots != null) {
      multiFormulaBaselineBuildings += Math.ceil(node.facilityCount);
    }
  });

  return {
    totalBuildings,
    totalPower,
    perFacility,
    multiFormulaActualBuildings,
    multiFormulaBaselineBuildings,
  };
}

/**
 * Byproduct entry as rendered by `CustomProductionNode`. `amount` is the
 * recipe-level per-cycle amount when sourced from a recipe's outputs;
 * meaningless (0) when sourced from a bin's aggregated `externalOutputs`,
 * since the rate is already pre-scaled.
 */
export type NodeByproduct = {
  item: Item;
  amount: number;
  rate: number;
};

/**
 * Compute the list of byproduct outputs for a production node's card.
 *
 * Two paths based on whether the node is part of a grouped bin:
 *
 *   1. **Grouped bin** (`node.bin?.isGrouped === true`): use ONLY the
 *      bin's `binExtraOutputs` (its `externalOutputs` minus the
 *      headline). Items that are internally balanced inside the bin
 *      (e.g. Sewage in a `{LX, XE, X}` Xircon bin where X produces it
 *      and XE consumes it 1:1) live in `bin.internalItems` and are
 *      correctly absent from `externalOutputs` — using this path
 *      prevents the headline recipe's natural byproducts from
 *      reintroducing them.
 *
 *   2. **Singleton bin / per-recipe view** (no `node.bin`): use the
 *      headline recipe's secondary outputs. For singletons the recipe
 *      cannot internally cancel anything (only one recipe), so its
 *      raw outputs match the bin's externals. For per-recipe view
 *      there is no bin abstraction at all; the recipe's outputs are
 *      the authoritative byproduct source.
 *
 * Both paths dedupe against the headline (`node.item.id`) and against
 * each other so an item never appears twice.
 *
 * The two paths are NEVER combined: combining them was the root cause
 * of the "Sewage shown as 60/min external on the Xircon bin" display
 * bug — the headline recipe's outputs would re-add Sewage that the
 * bin had correctly classified as internal.
 */
export function computeNodeByproducts(
  node: ProductionNode,
  items: Item[],
): NodeByproduct[] {
  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const seen = new Set<string>([node.item.id]);
  const result: NodeByproduct[] = [];

  // Grouped bin: bin.externalOutputs is authoritative; recipe-level
  // byproducts would re-introduce internally-balanced items.
  if (node.bin?.isGrouped) {
    for (const io of node.binExtraOutputs ?? []) {
      if (seen.has(io.itemId)) continue;
      const item = itemById.get(io.itemId);
      if (!item) continue;
      seen.add(io.itemId);
      result.push({ item, amount: 0, rate: io.rate });
    }
    return result;
  }

  // Singleton bin or per-recipe view: recipe.outputs is authoritative.
  // Byproduct rate is derived from primary output's rate via the cycle
  // ratio (byproduct.amount / primary.amount × headline targetRate); if
  // no primary match exists (defensive — recipe with no output matching
  // node.item.id), fall back to per-facility rate.
  const recipe = node.recipe;
  if (recipe && recipe.outputs.length > 1) {
    const primaryOutput = recipe.outputs.find(
      (p) => p.itemId === node.item.id,
    );
    for (const o of recipe.outputs) {
      if (o.itemId === node.item.id) continue;
      if (seen.has(o.itemId)) continue;
      const item = itemById.get(o.itemId);
      if (!item) continue;
      const rate = primaryOutput
        ? (o.amount / primaryOutput.amount) * node.targetRate
        : calcRate(o.amount, recipe.craftingTime) * node.facilityCount;
      seen.add(o.itemId);
      result.push({ item, amount: o.amount, rate });
    }
  }

  return result;
}

/**
 * Pick the bin's "headline" external output — the one displayed as the
 * card's primary item. Used by the bin-fusion view when a multi-formula
 * building has several external outputs and one of them must be chosen
 * for the prominent slot. Other external outputs become byproducts.
 *
 * Heuristic priority (deterministic):
 *   1. Items the user explicitly targeted.
 *   2. Highest item tier (more refined items take precedence).
 *   3. Solid items over liquids (solids are usually the "products";
 *      liquids tend to be intermediates or byproducts).
 *   4. Alphabetical itemId (stable tiebreak).
 *
 * Returns the headline `itemId` plus the bin recipe whose primary
 * output equals that item — or `null` if the bin has no external
 * outputs (degenerate case; pure consumer bin).
 */
export function pickBinHeadlineOutput(
  bin: Bin,
  items: Item[],
  recipes: Recipe[],
  targetItemIds: Set<ItemId>,
): { itemId: ItemId; recipeId: RecipeId } | null {
  if (bin.externalOutputs.length === 0) return null;

  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const recipeById = new Map(recipes.map((r) => [r.id, r] as const));

  // Score each output: lower score = higher priority.
  // Lex tuple: (isTarget desc, tier desc, isSolid desc, itemId asc).
  const scored = bin.externalOutputs.map((out) => {
    const item = itemById.get(out.itemId);
    return {
      itemId: out.itemId,
      isTarget: targetItemIds.has(out.itemId) ? 0 : 1,
      negTier: item ? -item.tier : 0,
      isLiquid: item?.isLiquid ? 1 : 0,
    };
  });
  scored.sort((a, b) => {
    if (a.isTarget !== b.isTarget) return a.isTarget - b.isTarget;
    if (a.negTier !== b.negTier) return a.negTier - b.negTier;
    if (a.isLiquid !== b.isLiquid) return a.isLiquid - b.isLiquid;
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
  });
  const headlineItemId = scored[0].itemId;

  // Find the bin recipe whose primary output is this item. Use
  // `getRecipeOutputItemId` semantics (same heuristic the rest of the
  // app uses for recipe primary-output selection) to handle multi-output
  // recipes deterministically.
  for (const rid of bin.recipeIds) {
    const recipe = recipeById.get(rid);
    if (!recipe) continue;
    if (recipe.outputs.some((o) => o.itemId === headlineItemId)) {
      return { itemId: headlineItemId, recipeId: rid };
    }
  }

  // Fallback: no recipe in the bin produces the headline item (would
  // indicate a data-layer bug — bin.externalOutputs is derived from the
  // bin's recipes). Return the first recipe id so callers don't crash.
  return { itemId: headlineItemId, recipeId: bin.recipeIds[0] };
}

/**
 * Returns ALL output item IDs for a recipe node in the production graph.
 */
function getRecipeOutputItemIds(
  plan: ProductionDependencyGraph,
  recipeId: string,
): string[] {
  return plan.edges
    .filter(
      (e) => e.from === recipeId && plan.nodes.get(e.to)?.type === "item",
    )
    .map((e) => e.to);
}

/**
 * Returns the primary output item of a recipe node. For multi-output recipes,
 * selects deterministically:
 *   1. Target items (the recipe's main purpose from the user's perspective)
 *   2. Items consumed by non-disposal recipes (active production chain items)
 *   3. First output alphabetically (stable fallback)
 */
export function getRecipeOutputItemId(
  plan: ProductionDependencyGraph,
  recipeId: string,
): string | undefined {
  const outputIds = getRecipeOutputItemIds(plan, recipeId);
  if (outputIds.length <= 1) return outputIds[0];

  // Prefer target items
  const targetOutput = outputIds.find((id) => {
    const node = plan.nodes.get(id);
    return node?.type === "item" && node.isTarget;
  });
  if (targetOutput) return targetOutput;

  // Prefer items consumed by non-disposal recipes (real production chain items)
  const consumedOutput = outputIds.find((id) =>
    plan.edges.some((e) => {
      if (e.from !== id) return false;
      const consumer = plan.nodes.get(e.to);
      return consumer?.type === "recipe" && !consumer.isDisposal;
    }),
  );
  if (consumedOutput) return consumedOutput;

  // Stable fallback: alphabetical
  return outputIds.sort()[0];
}

/**
 * Determines whether a recipe is a "terminal target" — meaning it can be
 * folded into a TargetSinkNode instead of being shown as a standalone node.
 *
 * A recipe is terminal only if:
 *   1. Its primary output is a target item with no non-disposal consumers
 *   2. None of its OTHER outputs are consumed by non-disposal recipes
 *
 * This ensures multi-output recipes that participate in cycles (e.g.,
 * pool_xiranite_poly_1 producing both xiranite_poly and liquid_sewage)
 * are never folded away — they must remain as visible nodes because
 * other recipes depend on their secondary outputs.
 */
export function isRecipeTerminal(
  plan: ProductionDependencyGraph,
  recipeId: string,
): boolean {
  const primaryOutputId = getRecipeOutputItemId(plan, recipeId);
  if (!primaryOutputId) return false;

  const primaryNode = plan.nodes.get(primaryOutputId);
  if (!primaryNode || primaryNode.type !== "item" || !primaryNode.isTarget)
    return false;

  // Primary output must not be consumed by any non-disposal recipe
  const primaryIsConsumed = plan.edges.some((e) => {
    if (e.from !== primaryOutputId) return false;
    const consumer = plan.nodes.get(e.to);
    return consumer?.type === "recipe" && !consumer.isDisposal;
  });
  if (primaryIsConsumed) return false;

  // No secondary output should be consumed by any recipe (including disposal).
  // Disposal-consumed secondaries must keep the recipe node visible so the
  // disposal edge has a source — otherwise the disposal sink ends up orphaned.
  const allOutputIds = getRecipeOutputItemIds(plan, recipeId);
  const hasSecondaryConsumer = allOutputIds.some((outId) => {
    if (outId === primaryOutputId) return false;
    return plan.edges.some((e) => {
      if (e.from !== outId) return false;
      return plan.nodes.get(e.to)?.type === "recipe";
    });
  });

  return !hasSecondaryConsumer;
}

/**
 * Returns all non-disposal recipes that produce an item, with their
 * individual production rates. Used to split flow across multiple producers
 * (e.g., liquid_sewage produced by both pool_xiranite_poly_1 and furnace).
 */
export function getItemProducers(
  plan: ProductionDependencyGraph,
  itemId: string,
): { recipeId: string; rate: number }[] {
  const itemNode = plan.nodes.get(itemId);
  if (itemNode?.type === "item" && itemNode.isRawMaterial) return [];

  return plan.edges
    .filter((e) => {
      if (e.to !== itemId) return false;
      const n = plan.nodes.get(e.from);
      return n?.type === "recipe" && !n.isDisposal;
    })
    .map((e) => {
      const node = plan.nodes.get(e.from) as Extract<
        ProductionGraphNode,
        { type: "recipe" }
      >;
      const out = node.recipe.outputs.find((o) => o.itemId === itemId);
      const rate = out
        ? calcRate(out.amount, node.recipe.craftingTime) * node.facilityCount
        : 0;
      return { recipeId: e.from, rate };
    })
    .filter((p) => p.rate > 0);
}

/**
 * Computes a greedy allocation of producer outputs to consumers, minimizing
 * the number of edges (pipe/belt connections) in the visualization.
 *
 * Instead of splitting each producer proportionally across all consumers,
 * assigns whole producer outputs to consumers first. A producer is only
 * split across consumers when its output exceeds one consumer's demand or
 * doesn't fully cover it.
 *
 * Producers are sorted by rate (descending) so large producers are assigned
 * first, maximizing the chance of whole-producer assignments.
 *
 * @returns consumerEdges — edges from producers to consumers with allocated rates
 * @returns remainingByProducer — leftover production per producer (for disposal)
 */
export function computeGreedyAllocation(
  producers: { recipeId: string; rate: number }[],
  consumers: { consumerId: string; demand: number }[],
): {
  consumerEdges: {
    producerRecipeId: string;
    consumerId: string;
    rate: number;
  }[];
  remainingByProducer: Map<string, number>;
} {
  // Sort producers by rate descending — assign large producers first
  const sorted = [...producers].sort((a, b) => b.rate - a.rate);
  const remaining = new Map(sorted.map((p) => [p.recipeId, p.rate]));

  const consumerEdges: {
    producerRecipeId: string;
    consumerId: string;
    rate: number;
  }[] = [];

  for (const consumer of consumers) {
    let remainingDemand = consumer.demand;
    for (const producer of sorted) {
      if (remainingDemand <= MIN_VISIBLE_RATE_PER_MIN) break;
      const available = remaining.get(producer.recipeId) || 0;
      if (available <= MIN_VISIBLE_RATE_PER_MIN) continue;

      const allocated = Math.min(available, remainingDemand);
      remaining.set(producer.recipeId, available - allocated);
      remainingDemand -= allocated;

      consumerEdges.push({
        producerRecipeId: producer.recipeId,
        consumerId: consumer.consumerId,
        rate: allocated,
      });
    }
  }

  return { consumerEdges, remainingByProducer: remaining };
}

/**
 * Find the first input item of a recipe node (e.g., for disposal/sink recipes).
 */
export function getRecipeInputItemId(
  plan: ProductionDependencyGraph,
  recipeId: string,
): string | undefined {
  return plan.edges.find((e) => e.to === recipeId)?.from;
}

