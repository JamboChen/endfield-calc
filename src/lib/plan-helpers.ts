import type {
  ProductionDependencyGraph,
  ProductionGraphNode,
  ProductionNode,
  Bin,
  BinId,
  Facility,
  FacilityId,
  ItemId,
  PlanWarning,
  RecipeId,
  Item,
  Recipe,
} from "@/types";
import { calcRate, getRawSourceRate } from "@/lib/utils";
import { MIN_VISIBLE_RATE_PER_MIN } from "@/lib/flow-thresholds";
import { mapPlacedFacilities, rawMaterialSources } from "@/data";

/**
 * Facility-category values for the fluid pump classes (25/26: pump-in
 * and pump-out) plus the 1.4 gas miner (41: `gas_pump_1`, the Gas
 * Extractor). These deploy onto fixed resource
 * spots — fluid bodies in the open world, gas vents — rather than
 * general-purpose Core-AIC grid tiles, so they contribute no grid
 * tiles (see `BinAggregates.totalTiles`) and count as pump pickups
 * rather than depot ports (see `useProductionStats.pumpPickupPoints`).
 */
export const PUMP_CATEGORIES: ReadonlySet<number> = new Set([25, 26, 41]);

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
   * Per-facility-id sum of RAW LP-derived counts (mode-independent).
   * Sum of `bin.buildingCount` across bins + fractional pickup-point
   * counts for source facilities. NOT ceilMode-adjusted — this is the
   * canonical "theoretical capacity required" value, used for the
   * stats panel's mode-independent row ordering and the utilization
   * figure.
   *
   * Distinct from `perFacility` (which applies ceilMode for display):
   * - `perFacility` answers "what should the UI show?".
   * - `rawPerFacility` answers "what does the LP say is needed?".
   * - `physicalPerFacility` answers "how many placements must the
   *   player actually build?" — the facility-cap detection input.
   */
  rawPerFacility: Map<FacilityId, number>;
  /**
   * Per-facility-id sum of PHYSICAL placement counts. **Always ceiled
   * regardless of `ceilMode`** (like `totalTiles`): per bin
   * `max(1, ceil(bin.buildingCount))`, plus `ceil(fractionalPickups)`
   * for pickup-point source facilities.
   *
   * This is the facility-cap detection input
   * (`computeOverCapWarnings`): in-game placement limits (e.g. Forge
   * of the Sky, capped by AIC research) are HARD — you cannot place
   * building N+1 — and they bind on whole buildings. A plan whose
   * fractional usage fits the cap can still be unbuildable when
   * single-formula recipes fragment it across more physical buildings
   * (Σ fractional 12.0 over five forge recipes ⇒ 13 placements).
   * Since `physical ≥ fractional` per facility, detecting on this map
   * subsumes the old fractional check. Mode-independence keeps the
   * warning stable across the "Round up facilities" toggle.
   */
  physicalPerFacility: Map<FacilityId, number>;
  /**
   * Σ Core-AIC build-grid tiles (`facility.footprint` width × depth ×
   * ceiled building count). **Always ceiled regardless of `ceilMode`** —
   * fractional buildings don't occupy fractional grid space. A lower
   * bound: belts/pipes/pylons aren't modelable. Two exclusions, both
   * for facilities that live outside the build grid:
   *   - fluid pumps (`PUMP_CATEGORIES`) deploy onto open-world fluid
   *     bodies;
   *   - `mapPlacedFacilities` (Sewage Inlet) are fixed map structures
   *     the player merely enables.
   * Facilities without a `footprint` contribute 0 (unknown ≠ guessed).
   */
  totalTiles: number;
  /**
   * Σ `node.powerGeneration × node.facilityCount` over power-generation
   * recipe nodes (Thermal Bank burn recipes). **Mode-independent**
   * (fractional LP bank counts in both views): generation is
   * fuel-supply-limited — a ceiled bank without extra batteries cannot
   * provide more power — so the fractional figure is what the battery
   * production actually sustains. The calculator's ceil-floor loop
   * sizes this to cover the ceilMode `totalPower` (whole buildings each
   * paying full power), so in the fractional view it shows headroom;
   * the hook-level power-deficit warning remains as the safety net for
   * the loop's iteration-cap residual case. 0 when the plan has no
   * power-generation nodes.
   */
  totalPowerGeneration: number;
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
 */
export function aggregateBinTotals(
  plan: ProductionDependencyGraph,
  facilities: readonly Facility[],
  items: readonly Item[],
  options: { ceilMode?: boolean } = {},
): BinAggregates {
  const { ceilMode = false } = options;
  const facilityById = new Map(facilities.map((f) => [f.id, f] as const));
  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const sumByBin = buildBinActivitySums(plan);

  let totalBuildings = 0;
  let totalPower = 0;
  let totalTiles = 0;
  const perFacility = new Map<FacilityId, number>();
  const rawPerFacility = new Map<FacilityId, number>();
  const physicalPerFacility = new Map<FacilityId, number>();

  const tilesPerBuilding = (facility: Facility): number => {
    if (!facility.footprint) return 0;
    if (mapPlacedFacilities.has(facility.id)) return 0;
    if (PUMP_CATEGORIES.has(facility.category)) return 0;
    return facility.footprint.width * facility.footprint.depth;
  };

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
    rawPerFacility.set(
      facility.id,
      (rawPerFacility.get(facility.id) ?? 0) + bin.buildingCount,
    );
    // Always-ceiled physical placements — cap detection input.
    physicalPerFacility.set(
      facility.id,
      (physicalPerFacility.get(facility.id) ?? 0) + ceiledBuildings,
    );
    // Always-ceiled — buildings occupy whole tiles in either view mode.
    totalTiles += tilesPerBuilding(facility) * ceiledBuildings;
  }

  // Power generation (Thermal Bank burn recipes): fuel-supply-limited,
  // so it follows the FRACTIONAL LP bank count in both view modes —
  // see the `totalPowerGeneration` field doc.
  let totalPowerGeneration = 0;
  for (const node of plan.nodes.values()) {
    if (node.type !== "recipe") continue;
    if (!node.powerGeneration) continue;
    totalPowerGeneration += node.powerGeneration * node.facilityCount;
  }

  // Fold pickup-point source facilities (unloader_1, pump_1, pump_2)
  // into the totals so the table footer / stats panel show source-
  // facility counts and power alongside production facilities. Pickup
  // counts respect `ceilMode` the same way bin counts do:
  //   - ceilMode=true  → ceiled physical pickup count (whole pumps),
  //     each paying full power per built pickup.
  //   - ceilMode=false → fractional pickup count (theoretical view),
  //     power scales proportionally with the fractional count. Matches
  //     the bin-loop semantic above so per-facility entries are
  //     comparable across both modes.
  for (const node of plan.nodes.values()) {
    if (node.type !== "item") continue;
    if (!node.isRawMaterial) continue;
    // Producible raws (Xiragen et al.) carry BOTH a vent/mine draw and a
    // crafted portion; `productionRate` is the total, but pumps only pick
    // up the mined portion — `rawSupplyRate`. Ordinary raws leave
    // `rawSupplyRate` undefined ⇒ fall back to `productionRate`.
    const drawRate = node.rawSupplyRate ?? node.productionRate;
    if (drawRate <= MIN_VISIBLE_RATE_PER_MIN) continue;
    const cfg = rawMaterialSources.get(node.itemId);
    if (!cfg) continue;
    const facility = facilityById.get(cfg.sourceFacility);
    if (!facility) continue;
    const item = itemById.get(node.itemId);
    const perFacilityRate = getRawSourceRate(node.itemId, item);
    if (perFacilityRate <= 0) continue;
    const fractionalPickups = drawRate / perFacilityRate;
    const effectivePickups = ceilMode
      ? Math.ceil(fractionalPickups)
      : fractionalPickups;
    totalBuildings += effectivePickups;
    totalPower += facility.powerConsumption * effectivePickups;
    perFacility.set(
      facility.id,
      (perFacility.get(facility.id) ?? 0) + effectivePickups,
    );
    rawPerFacility.set(
      facility.id,
      (rawPerFacility.get(facility.id) ?? 0) + fractionalPickups,
    );
    // Always-ceiled physical pickups — mirrors the bin loop so cap
    // detection uniformly covers source facilities too.
    physicalPerFacility.set(
      facility.id,
      (physicalPerFacility.get(facility.id) ?? 0) +
        Math.ceil(fractionalPickups),
    );
    // Pickup tiles: unloaders sit on the depot bus inside the build
    // grid; pumps are filtered out by `tilesPerBuilding` (open-world
    // fluid bodies). Always-ceiled, mirroring the bin loop.
    totalTiles += tilesPerBuilding(facility) * Math.ceil(fractionalPickups);
  }

  return {
    totalBuildings,
    totalPower,
    perFacility,
    rawPerFacility,
    physicalPerFacility,
    totalTiles,
    totalPowerGeneration,
  };
}

/**
 * Plan-warning kinds that mean "this plan exceeds a configured limit"
 * — the single source of truth shared by the optimizer's
 * `isPlanFeasible` (Fit/Max reject such plans) and the hook's
 * `planOverLimit` (Fit pill / auto-fit trigger). The two consumers
 * drifted once before (metastorage); any future soft tier that emits
 * an over-limit warning must ONLY be added here.
 *
 * Every kind in this set is emitted INTO `plan.warnings` by
 * `calculateProductionPlan` itself (the cap kinds via
 * `computeLimitViolations` at plan assembly) — so the verdict "is this
 * plan over its limits?" is a plain warning scan for every consumer,
 * and an optimizer probe judges the exact plan the UI would show.
 * Enrolling a new limit = emit its warning in the calculator + add the
 * kind here. Nothing else.
 *
 * Deliberately excludes `power-sustain-unavailable` — "no fuel exists"
 * is a configuration state, not a limit violation; scaling targets
 * cannot fix it.
 */
export const OVER_LIMIT_WARNING_KINDS: ReadonlySet<PlanWarning["kind"]> =
  new Set([
    "facility-over-cap",
    "raw-over-cap",
    "metastorage-budget-insufficient",
    "power-sustain-insufficient",
  ]);

/**
 * The single limit-violation judge, run by `calculateProductionPlan`
 * at plan assembly (each ceil-floor iteration re-assembles, so the
 * final plan always carries a fresh verdict):
 *
 *   - Facility caps against `physicalPerFacility` — always-ceiled
 *     physical placement counts, mode-independent (see the
 *     `BinAggregates.physicalPerFacility` doc for why fractional
 *     usage under-detects).
 *   - Raw caps against the plan's raw-node requirement fold: raw item
 *     nodes (plus manually-pinned raws — mirrors
 *     `useProductionStats.collectStats`) summed by `productionRate`.
 *
 * Runs on the UNfiltered plan: `filterPlanForDisplay` only drops
 * zero-rate nodes, which contribute nothing to either check, and
 * `plan.bins` is identical either way — so this verdict matches what
 * the display-layer chrome derives (probe/badge parity is structural).
 */
export function computeLimitViolations(
  plan: ProductionDependencyGraph,
  facilities: readonly Facility[],
  items: readonly Item[],
  ctx: {
    facilityCaps?: ReadonlyMap<FacilityId, number>;
    rawCaps?: ReadonlyMap<ItemId, number>;
    manualRawMaterials?: ReadonlySet<ItemId>;
  },
): PlanWarning[] {
  const hasFacilityCaps = !!ctx.facilityCaps && ctx.facilityCaps.size > 0;
  const hasRawCaps = !!ctx.rawCaps && ctx.rawCaps.size > 0;
  if (!hasFacilityCaps && !hasRawCaps) return [];

  const warnings: PlanWarning[] = [];
  if (hasFacilityCaps) {
    const aggregates = aggregateBinTotals(plan, facilities, items);
    warnings.push(
      ...computeOverCapWarnings(
        aggregates.physicalPerFacility,
        ctx.facilityCaps,
      ),
    );
  }
  if (hasRawCaps) {
    const rawRequirements = new Map<ItemId, number>();
    for (const node of plan.nodes.values()) {
      if (node.type !== "item") continue;
      if (node.isRawMaterial || ctx.manualRawMaterials?.has(node.itemId)) {
        // Producible raws (Xiragen et al.): only the vent/mine draw
        // (`rawSupplyRate`) is bounded by the node cap — the crafted
        // portion of `productionRate` isn't mined. Ordinary raws leave
        // `rawSupplyRate` undefined ⇒ fall back to `productionRate`.
        const drawRate = node.rawSupplyRate ?? node.productionRate;
        rawRequirements.set(
          node.itemId,
          (rawRequirements.get(node.itemId) ?? 0) + drawRate,
        );
      }
    }
    warnings.push(...computeRawOverCapWarnings(rawRequirements, ctx.rawCaps));
  }
  return warnings;
}

/**
 * Detect facility-cap overflows.
 *
 * Pure function. Iterates `facilityCaps` (not `perFacilityUsage`) so
 * caps on facilities absent from the plan are skipped naturally.
 *
 * The app feeds it `aggregates.physicalPerFacility` (always-ceiled
 * placement counts): in-game placement limits are HARD — the game
 * refuses building N+1 — and bind on whole buildings. Fractional LP
 * usage that fits the cap can still be unbuildable when
 * single-formula recipes fragment it across more physical buildings
 * (Forge of the Sky: Σ fractional 12.0 over five recipes ⇒ 13
 * placements > cap 12). Physical ≥ fractional per facility, so this
 * input subsumes the old fractional check; being mode-independent it
 * also keeps detection stable across the "Round up facilities"
 * toggle.
 *
 * Comparison: `used > cap + EPSILON`. Caps are integer by construction
 * (`parseInt`-guarded at the UI input); the EPSILON absorbs float
 * drift. NO ceil on the comparison — that would spuriously fire for
 * fractional caps if they ever become supported.
 *
 * Coverage:
 *   - Multi-formula MIP-packed bins (e.g. mix_pool_2 / Expanded Crucible).
 *   - Single-formula singleton bins (e.g. xiranite_oven_1 / Forge of the Sky).
 *   - Pickup-point source facilities (pump_1, pump_2, unloader_1) —
 *     these were the architectural gap of the packer-side check; now
 *     covered uniformly through `physicalPerFacility`.
 *
 * The MIP cap constraint inside `multi-formula-packing.ts:solvePacking`
 * is the FIRST line of defence — it tries to find a packing that
 * respects caps. This function is the SECOND line: when the MIP gives
 * up (cap infeasible, retries without caps) OR when singletons /
 * pickups push a facility over its cap, this surfaces the violation.
 */
export function computeOverCapWarnings(
  perFacilityUsage: ReadonlyMap<FacilityId, number>,
  facilityCaps: ReadonlyMap<FacilityId, number> | undefined,
): PlanWarning[] {
  if (!facilityCaps || facilityCaps.size === 0) return [];
  const warnings: PlanWarning[] = [];
  const EPSILON = 1e-9;
  for (const [facilityId, cap] of facilityCaps) {
    if (!Number.isFinite(cap) || cap < 0) continue;
    const used = perFacilityUsage.get(facilityId) ?? 0;
    if (used <= cap + EPSILON) continue;
    warnings.push({ kind: "facility-over-cap", facilityId, used, cap });
  }
  return warnings;
}

/**
 * Detect raw-material cap overflows.
 *
 * Pure function. Iterates `rawCaps` (not `rawMaterialRequirements`) so
 * caps for items absent from the plan's demand are skipped naturally
 * (no consumption → no warning). **Items not present in `rawCaps` are
 * unconstrained** ("no entry = no limit"); they don't appear in the
 * iteration so no warning can possibly fire for them.
 *
 * Mirrors `computeOverCapWarnings` precisely:
 *   - Comparison: `used > cap + EPSILON` (absorbs LP solver float drift).
 *   - Negative / non-finite caps are skipped defensively.
 *   - Detection threshold is invariant to `ceilMode` — display
 *     formatting in the warning consumer applies that.
 *
 * Mode-of-emission: the calculator runs this at plan assembly (via
 * `computeLimitViolations` above), comparing the packed plan's
 * raw-node requirement fold against the user's caps — the result
 * lands in `plan.warnings`, the shared over-limit verdict. The LP
 * layer separately adds slack-based upper-bound constraints (see
 * `lp-solver.ts`); the two work together — the LP biases toward
 * conservation, this surfaces residual overage.
 */
export function computeRawOverCapWarnings(
  rawMaterialRequirements: ReadonlyMap<ItemId, number>,
  rawCaps: ReadonlyMap<ItemId, number> | undefined,
): PlanWarning[] {
  if (!rawCaps || rawCaps.size === 0) return [];
  const warnings: PlanWarning[] = [];
  const EPSILON = 1e-9;
  for (const [itemId, cap] of rawCaps) {
    if (!Number.isFinite(cap) || cap < 0) continue;
    const used = rawMaterialRequirements.get(itemId) ?? 0;
    if (used <= cap + EPSILON) continue;
    warnings.push({ kind: "raw-over-cap", itemId, used, cap });
  }
  return warnings;
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
  recipes: readonly Recipe[],
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
 * Allocates producer outputs to consumer demands, minimizing the number of
 * edges (pipe/belt connections) in the visualization. Single source of truth
 * for producer→consumer decomposition — used by merged-mapper (per-recipe),
 * bin-fused Recipe View (per-bin), and bin-fused Facility View
 * (per-building instance and raw-material pickup instances).
 *
 * Consumers are processed in REGISTRATION ORDER — callers register target
 * sinks before disposal sinks so targets get first claim (see
 * .claude/rules/mappers.md). For each consumer, the tiers:
 *
 *   1. Exact-fit: a producer whose available output matches the remaining
 *      demand (within MIN_VISIBLE_RATE_PER_MIN) is taken whole. Prevents
 *      a small consumer from nibbling a large producer that exactly
 *      matches a later consumer (the 3-belts-where-2-suffice bug, #91).
 *   2. Whole-fit: the largest producer that fits entirely within the
 *      remaining demand is taken whole (first-fit-decreasing) — UNLESS its
 *      supply exactly matches a still-pending consumer demand, in which
 *      case it is reserved for that consumer and skipped here.
 *   3. Best-fit split: producers exceeding the demand — prefer one whose
 *      post-split REMAINDER exactly matches a pending demand (the
 *      remainder becomes a future exact-fit instead of a stray fragment);
 *      otherwise split the SMALLEST sufficient producer, preserving large
 *      producers whole for later consumers.
 *   4. Reserved whole-fit: only when nothing else can serve the demand,
 *      fall back to producers skipped by tier 2.
 *
 * The pending-demand reservation (tiers 2–3) is what prevents fragment
 * daisy-chains: with uniform 60/min pumps feeding 30/min consumers plus a
 * few partial-load 28.8/min ones, the unreserved greedy ate every 28.8
 * fragment with whole-fit and re-split a fresh pump for the missing 1.2,
 * cascading 1.2/28.8 complement edges across the whole pickup row.
 *
 * Every avoided split saves a transport (belts are ceil(rate/30) per edge),
 * so edge minimization is belt minimization in practice.
 *
 * @returns edges — producer→consumer edges with allocated rates
 * @returns remainingByProducer — leftover production per producer (for
 *   disposal). Contains EVERY producer id, drained ones at 0.
 */
export function computeTransportAllocation(
  producers: { id: string; rate: number }[],
  consumers: { id: string; rate: number }[],
): {
  edges: { producerId: string; consumerId: string; rate: number }[];
  remainingByProducer: Map<string, number>;
} {
  const remaining = new Map(producers.map((p) => [p.id, p.rate]));

  const edges: { producerId: string; consumerId: string; rate: number }[] = [];

  // Demands of consumers not yet processed (current consumer excluded).
  // A producer (or split remainder) matching one of these is destined to
  // become that consumer's exact-fit.
  const pending = consumers.map((c) => c.rate);
  const matchesPending = (value: number): boolean =>
    pending.some(
      (demand) =>
        demand > MIN_VISIBLE_RATE_PER_MIN &&
        Math.abs(demand - value) <= MIN_VISIBLE_RATE_PER_MIN,
    );

  for (let ci = 0; ci < consumers.length; ci++) {
    const consumer = consumers[ci];
    pending[ci] = 0; // no longer pending — being processed now
    let need = consumer.rate;
    while (need > MIN_VISIBLE_RATE_PER_MIN) {
      let exactId: string | undefined;
      let wholeId: string | undefined;
      let wholeAvail = 0;
      let reservedWholeId: string | undefined;
      let reservedWholeAvail = 0;
      let splitId: string | undefined;
      let splitAvail = Infinity;
      let splitMatchId: string | undefined;
      let splitMatchAvail = Infinity;
      for (const [id, avail] of remaining) {
        if (avail <= MIN_VISIBLE_RATE_PER_MIN) continue;
        if (Math.abs(avail - need) <= MIN_VISIBLE_RATE_PER_MIN) {
          exactId = id;
          break;
        }
        if (avail < need) {
          if (matchesPending(avail)) {
            if (avail > reservedWholeAvail) {
              reservedWholeAvail = avail;
              reservedWholeId = id;
            }
          } else if (avail > wholeAvail) {
            wholeAvail = avail;
            wholeId = id;
          }
        } else {
          if (matchesPending(avail - need)) {
            if (avail < splitMatchAvail) {
              splitMatchAvail = avail;
              splitMatchId = id;
            }
          }
          if (avail < splitAvail) {
            splitAvail = avail;
            splitId = id;
          }
        }
      }

      const producerId =
        exactId ?? wholeId ?? splitMatchId ?? splitId ?? reservedWholeId;
      if (producerId === undefined) break; // demand exceeds total supply

      const avail = remaining.get(producerId)!;
      const allocated = exactId !== undefined ? avail : Math.min(avail, need);
      remaining.set(producerId, avail - allocated);
      need -= allocated;

      edges.push({ producerId, consumerId: consumer.id, rate: allocated });
    }
  }

  return { edges, remainingByProducer: remaining };
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

/**
 * Filter a solved plan down to its **display** subgraph: drop recipe
 * nodes the LP didn't run (`facilityCount === 0`) and item nodes with
 * no throughput (`productionRate === 0`), then drop edges that lost an
 * endpoint. Targets and invalid-cycle nodes are always kept so the
 * user can still see requested outputs and what went wrong.
 *
 * **Metastorage exemption**: an item-node's `productionRate` counts
 * LOCAL production only — imported supply lives on
 * `plan.metastorageImports`, never folded into the node (see
 * `calculator.ts:buildProductionGraph`). An item supplied entirely by
 * import therefore has `productionRate === 0` yet is fully active;
 * without this exemption it (and its consuming edges) would vanish
 * from the table, the TTV footer, and the merged (bf=0) graph while
 * the bin-fused view — which reads `plan.bins` + imports directly —
 * still rendered it, leaving the two views contradicting each other.
 *
 * Pure (no React state); the hook memoises the call. Unit-tested in
 * `plan-helpers.test.ts`.
 */
export function filterPlanForDisplay(
  plan: ProductionDependencyGraph,
): ProductionDependencyGraph {
  const invalidCycleItems = new Set<ItemId>();
  const invalidCycleRecipes = new Set<RecipeId>();
  for (const ic of plan.invalidCycles) {
    ic.involvedItemIds.forEach((id) => invalidCycleItems.add(id));
    ic.involvedRecipeIds.forEach((id) => invalidCycleRecipes.add(id));
  }
  // Only VISIBLE imports keep their item alive — the table
  // (`mergeItemNodes`) and mappers both gate import rendering at
  // `MIN_VISIBLE_RATE_PER_MIN`, so exempting a sub-visible import here
  // would keep a zero-local-rate item node with no import row/node to
  // match (a stray empty table row). Same threshold everywhere.
  const importedItems = new Set<ItemId>();
  for (const imp of plan.metastorageImports) {
    if (imp.ratePerMinute > MIN_VISIBLE_RATE_PER_MIN) {
      importedItems.add(imp.itemId);
    }
  }

  const activeNodes = new Map<string, ProductionGraphNode>();
  for (const [key, node] of plan.nodes) {
    if (
      node.type === "recipe" &&
      node.facilityCount === 0 &&
      !invalidCycleRecipes.has(node.recipeId)
    ) {
      continue;
    }
    if (
      node.type === "item" &&
      node.productionRate === 0 &&
      !plan.targets.has(node.itemId) &&
      !invalidCycleItems.has(node.itemId) &&
      !importedItems.has(node.itemId)
    ) {
      continue;
    }
    activeNodes.set(key, node);
  }
  const activeEdges = plan.edges.filter(
    (edge) => activeNodes.has(edge.from) && activeNodes.has(edge.to),
  );
  return { ...plan, nodes: activeNodes, edges: activeEdges };
}

