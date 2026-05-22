/**
 * Phase 3: pack multi-formula facility recipes into shared buildings.
 *
 * Given Phase 2's per-recipe slot demands (`recipeFacilityCounts`), this
 * module decides how those slots are physically realised. For multi-formula
 * facilities (those with `cacheSlots` defined), multiple recipes may share
 * a single building, sharing inner-slot inventory and external port
 * budget. Each "bin" of buildings has the same recipe configuration;
 * each building of that bin provides 1 slot of each constituent recipe
 * per cycle.
 *
 * Path-H algorithm — shape variant enumeration with strict-equality
 * demand matching:
 *
 *   1. Group recipes by facility. Per facility, enumerate every valid
 *      bin **shape** (subset of recipes hostable on that facility).
 *      For each shape, enumerate every cap-feasible **variant** — one
 *      per possible internal/external/in/out classification of items
 *      that are both produced AND consumed within the shape (the
 *      "borderline" items). Each variant has a fixed canonical
 *      rate-direction vector derived from the null space of its
 *      internal-item equality matrix.
 *
 *      Variants whose port count exceeds facility caps are rejected at
 *      enumeration time and never reach the LP — port safety is by
 *      construction.
 *
 *   2. For each pool of recipes that share equivalent I/O across
 *      facilities (e.g. `MIX_POOL_1` ↔ `MIX_POOL_2` byte-identical
 *      twins), expose all variants to the LP so it can pick whichever
 *      facility best amortizes power and building cost.
 *
 *   3. Solve a lex three-pass MIP over variants:
 *        - Pass 1: minimise total buildings (Σ x_v).
 *        - Pass 2: minimise total power subject to pass-1 optimum.
 *        - Pass 3: minimise total shape-size sum (compactness tiebreak)
 *          subject to pass-1 + pass-2 optima.
 *
 *      Variables: integer `x_v ≥ 0` per variant (building count) +
 *      continuous `u_v ≥ 0` per variant (scale factor for the variant's
 *      canonical rate direction). Active rates: `y_r = u_v ×
 *      rateDirection[r]`. Capacity: `u_v ≤ x_v`.
 *
 *      Demand coverage uses **strict equality**: `Σ_v u_v × dir_v[r] =
 *      demand_r`. This guarantees the LP produces a plan whose recipe
 *      rates EXACTLY match Phase 2's demand — no over-production, no
 *      under-production. The variant combination required to meet
 *      this may use more buildings than a slack-tolerant alternative,
 *      but every emitted building physically runs at the rate Phase 2
 *      provisioned.
 *
 *   4. Emit `Bin[]` directly from LP output (`x_v`, `u_v`).
 *      Externals/internals are determined by the variant's classification;
 *      rates are computed from the actual `u_v × rateDirection[r]` values.
 *
 * Recipes hosted by single-formula facilities (no `cacheSlots`) produce
 * a trivial singleton bin per recipe so downstream consumers always see
 * a uniform data shape.
 *
 * **Equality-LP infeasibility:** if Phase 2's demand ratios fall outside
 * the conic hull of cap-feasible variant directions, the LP returns
 * infeasible. In test mode this throws (it shouldn't happen on current
 * game data); in production we fall back to `emitSingletonBins` for
 * every recipe, which is always exact-match feasible.
 *
 * **Architecture**: enumerate every cap-feasible shape-variant up
 * front, then solve a strict-equality LP/MIP over those variants
 * for active-slot counts. Port-cap feasibility is guaranteed by
 * construction rather than by LP constraints, which keeps the LP
 * clean and the solver fast. Tests under "port-cap invariants"
 * pin this invariant.
 *
 * **Alternative not taken**: encoding per-variant port-cap
 * enforcement as big-M indicator constraints inside the MIP,
 * skipping the explicit variant-enumeration step. Fewer variables
 * but more constraint complexity. Viable if variant enumeration
 * ever becomes a bottleneck for game data with many borderline
 * items per shape.
 */

import { calcRate } from "@/lib/utils";
import { solve as highsSolve, type LPModel } from "@/lib/highs-wrapper";
import type {
  Item,
  Recipe,
  Facility,
  ItemId,
  RecipeId,
  FacilityId,
  BinId,
  Bin,
  PlanWarning,
  RecipeBinAllocation,
} from "@/types";

/** Numerical tolerance below which net flow is treated as zero (fully internal). */
const NET_FLOW_EPSILON = 1e-9;

/** Tolerance for treating slot demands / active slot counts as zero. */
const SLOT_DEMAND_EPSILON = 1e-9;

/**
 * Building-count slack added to lex pass 2's cap to absorb LP solver
 * noise. HiGHS's `primal_feasibility_tolerance` is configured to
 * 1e-10 in the wrapper, so 1e-9 is a small defensive cushion.
 */
const LEX_BUILDINGS_TOLERANCE = 1e-9;

/**
 * Power-budget slack added to lex pass 3's cap to absorb LP solver
 * noise. Same HiGHS-precision justification as
 * `LEX_BUILDINGS_TOLERANCE` above.
 */
const LEX_POWER_TOLERANCE = 1e-6;

/**
 * Threshold for emitting a dev-console warning when a single shape
 * produces an excessive number of variants. Signals that game data has
 * grown beyond the original assumption (k ≤ 4 borderline items per
 * shape, 3^k ≤ 81 regimes); if hit, consider tightening enumeration
 * pruning.
 */
const VARIANT_COUNT_WARN_THRESHOLD = 100;

export type PackingInput = {
  /** Per-recipe slot demands from Phase 2. */
  recipeSlotDemands: Map<RecipeId, number>;
  recipeMap: Map<RecipeId, Recipe>;
  itemMap: Map<ItemId, Item>;
  facilityMap: Map<FacilityId, Facility>;
  /**
   * Optional user-pinned recipe variants. When set for an item, the
   * solver forces the corresponding recipe to be the producer. The
   * packer respects this by treating non-pinned twins as unavailable
   * substitutes for the pinned recipe's slot demand.
   */
  recipeOverrides?: Map<ItemId, RecipeId>;
  /**
   * Optional per-facility building-count caps. When set, the MIP adds
   * `Σ x_v ≤ N_F` for each capped facility `F` (sum over all variants
   * whose `variant.facility.id === F`). When the cap renders the MIP
   * infeasible the packer retries without the caps and emits a warning
   * into `PackingResult.warnings` rather than failing.
   *
   * Twin facilities (e.g. MIX_POOL_1 / MIX_POOL_2 sharing recipes) each
   * carry their own cap; the MIP shifts demand to the cheaper feasible
   * facility automatically.
   */
  facilityCaps?: ReadonlyMap<FacilityId, number>;
};

export type PackingResult = {
  bins: Bin[];
  allocations: Map<RecipeId, RecipeBinAllocation>;
  /**
   * Structured non-fatal warnings emitted from packing. See
   * `PlanWarning` in `src/types/production.ts` for the discriminant
   * union. Today's emitters:
   *   - `packer-override-infeasible` — recipe-override pinning a
   *     variant whose facility has no valid bin shape.
   *   - `packer-fallback` — generic LP-fallback signal when the MIP
   *     can't solve the demand under strict equality.
   *   - `facility-over-cap` — total `buildingCount` for a capped
   *     facility exceeds the cap (post-packing check, covers both
   *     MIP-packed and singleton bins).
   *
   * Consumer (`useProductionPlan.warnings` memo) formats each kind
   * with `ceilMode` + i18n before display.
   */
  warnings: PlanWarning[];
};

/**
 * Classification of an item in a variant's regime.
 *
 * - `internal`: produced AND consumed inside the bin at exactly equal
 *   rates; no port used. The LP adds an equality constraint on the
 *   active slot variables.
 * - `external-in`: net consumption > production; takes one liquid-in
 *   (or belt-in) port slot. The LP adds a `≤ 0` inequality.
 * - `external-out`: net production > consumption; takes one liquid-out
 *   (or belt-out) port slot. The LP adds a `≥ 0` inequality.
 */
type ItemClassification = "internal" | "external-in" | "external-out";

/**
 * Shape variant: a recipe subset on a particular facility with a
 * specific regime (per-item internal/external classification) AND a
 * fixed rate-direction vector that the LP scales linearly.
 *
 * Each shape (recipe set + facility) may yield multiple variants. The
 * LP picks among cap-feasible variants via per-variant scale variables
 * `u_v ≥ 0` (one continuous per variant). Active recipe rates are
 * `y_r = u_v × rateDirection[r]`.
 *
 * `rateDirection[r]` is the per-slot active-rate of recipe `r` per unit
 * scale `u_v`. Computed at enumeration time from the null space of the
 * variant's internal-item equality constraints. Always non-negative;
 * normalised so the maximum component equals 1 (so the capacity
 * constraint `u_v ≤ x_v` is in units of "max-utilisation building").
 */
type BinShapeVariant = {
  /** Stable identifier: `${facilityId}:${recipeIds.join(",")}#v${idx}`. */
  variantId: string;
  facility: Facility;
  /** Sorted recipe IDs (deterministic). */
  recipeIds: RecipeId[];
  /**
   * Normalised rate-direction vector (one entry per recipe in order of
   * `recipeIds`). The LP picks a scalar `u_v ≥ 0` and active rates are
   * `y_r = rateDirection[r] * u_v`. Normalised so `max(rateDirection) = 1`
   * → capacity constraint becomes simply `u_v ≤ x_v`.
   */
  rateDirection: number[];
  /** Distinct item count occupying inner slots (shape-invariant). */
  innerSlotsUsed: number;
};

/**
 * Stable signature for a recipe: sorted I/O lines plus crafting time.
 * Excludes `id` and `facilityId` so byte-identical twins on different
 * facilities collapse to the same signature.
 */
const recipeSignature = (r: Recipe): string => {
  const ins = r.inputs
    .map((i) => `${i.itemId}:${i.amount}`)
    .sort()
    .join(",");
  const outs = r.outputs
    .map((o) => `${o.itemId}:${o.amount}`)
    .sort()
    .join(",");
  return `in:${ins}|out:${outs}|t:${r.craftingTime}`;
};

/**
 * Given a recipe `r`, find every recipe in the data set that is
 * functionally equivalent (same inputs, outputs, craftingTime — modulo
 * recipe ID and facility ID). The packer uses these as substitutes:
 * any unit of `r`'s slot demand may be served by any equivalent recipe
 * since they produce identical I/O at the same rate.
 *
 * This is the mechanism by which `_1` and `_2` pool recipes both become
 * candidates for the LP regardless of which one Phase 2 picked.
 */
const findRecipeAlternatives = (
  target: Recipe,
  recipes: Recipe[],
): Recipe[] => {
  const targetSig = recipeSignature(target);
  return recipes.filter((r) => recipeSignature(r) === targetSig);
};

/**
 * Compute the per-item-per-recipe coefficient matrix for a recipe set.
 * Coefficient = output_rate − input_rate at 1 active slot per recipe.
 *
 * Returns `null` if the recipe set's distinct item count exceeds the
 * facility's inner-slot budget (shape-level invariant).
 */
const buildItemCoefficients = (
  recipes: Recipe[],
  facility: Facility,
): {
  coeffs: Map<ItemId, Map<RecipeId, number>>;
  itemsTouched: Set<ItemId>;
} | null => {
  const innerSlots = facility.cacheSlots;
  if (innerSlots == null) return null;

  const coeffs = new Map<ItemId, Map<RecipeId, number>>();
  const itemsTouched = new Set<ItemId>();

  const addCoeff = (itemId: ItemId, recipeId: RecipeId, delta: number) => {
    let row = coeffs.get(itemId);
    if (!row) {
      row = new Map();
      coeffs.set(itemId, row);
    }
    row.set(recipeId, (row.get(recipeId) ?? 0) + delta);
  };

  for (const r of recipes) {
    for (const inp of r.inputs) {
      itemsTouched.add(inp.itemId);
      addCoeff(inp.itemId, r.id, -calcRate(inp.amount, r.craftingTime));
    }
    for (const out of r.outputs) {
      itemsTouched.add(out.itemId);
      addCoeff(out.itemId, r.id, calcRate(out.amount, r.craftingTime));
    }
  }

  if (itemsTouched.size > innerSlots) return null;
  return { coeffs, itemsTouched };
};

/**
 * Classify items into three pools based on their participation in the
 * recipe set's I/O:
 *
 *   - `alwaysIn`: only consumed (no producer in this shape) → always
 *     external IN. No regime choice.
 *   - `alwaysOut`: only produced (no consumer in this shape) → always
 *     external OUT. No regime choice.
 *   - `borderline`: both produced AND consumed → classification depends
 *     on relative active rates. Enumerated as `internal` / `external-in`
 *     / `external-out` per variant.
 */
const classifyItems = (
  coeffs: Map<ItemId, Map<RecipeId, number>>,
): {
  alwaysIn: ItemId[];
  alwaysOut: ItemId[];
  borderline: ItemId[];
} => {
  const alwaysIn: ItemId[] = [];
  const alwaysOut: ItemId[] = [];
  const borderline: ItemId[] = [];

  for (const [itemId, row] of coeffs.entries()) {
    let hasProducer = false;
    let hasConsumer = false;
    for (const c of row.values()) {
      if (c > NET_FLOW_EPSILON) hasProducer = true;
      else if (c < -NET_FLOW_EPSILON) hasConsumer = true;
    }
    if (hasProducer && hasConsumer) borderline.push(itemId);
    else if (hasConsumer) alwaysIn.push(itemId);
    else if (hasProducer) alwaysOut.push(itemId);
    // Else: item appears with coefficient zero (defensive; should be unreachable).
  }

  // Deterministic order matters for variant id stability.
  alwaysIn.sort();
  alwaysOut.sort();
  borderline.sort();
  return { alwaysIn, alwaysOut, borderline };
};

/**
 * Compute a canonical rate-direction vector for a candidate variant
 * (the ratios at which the variant's recipes co-run), OR return `null`
 * if the variant is parametrically infeasible (no positive solution
 * satisfies the regime constraints).
 *
 * Method:
 *   1. Build the equality constraint matrix `A` from the variant's
 *      internal-item classifications: each internal item gives one row.
 *   2. Compute the null space of `A` via Gaussian elimination with back-
 *      substitution. The null space is the set of rate-vectors that
 *      respect all internal-item equalities.
 *   3. If the null space is 0-dimensional → `rank(A) = n` → only `y=0`
 *      satisfies → reject.
 *   4. If non-empty: pick the first basis vector. If it has a negative
 *      component, negate it (we need a non-negative direction). If after
 *      sign-fixing some component remains negative, the variant has no
 *      strictly-positive ray → reject.
 *   5. Normalise so `max(component) = 1` for clean capacity scaling.
 *
 * Variants with rank < n − 1 (multiple free directions) get the FIRST
 * basis vector. This collapses each variant to a single ray; some
 * theoretically-better allocations within the variant's cone may be
 * unreachable, but in practice the LP can still combine variants to
 * cover any demand.
 */
const computeVariantRateDirection = (
  recipes: RecipeId[],
  coeffs: Map<ItemId, Map<RecipeId, number>>,
  classification: Map<ItemId, ItemClassification>,
): number[] | null => {
  const n = recipes.length;
  if (n === 0) return null;

  // Collect rows: one per internal item, indexed by recipe order.
  const rowsRaw: number[][] = [];
  for (const [itemId, kind] of classification.entries()) {
    if (kind !== "internal") continue;
    const coeffRow = coeffs.get(itemId);
    if (!coeffRow) continue;
    const row = new Array<number>(n).fill(0);
    let nonZero = false;
    recipes.forEach((rid, i) => {
      const c = coeffRow.get(rid) ?? 0;
      row[i] = c;
      if (Math.abs(c) > NET_FLOW_EPSILON) nonZero = true;
    });
    if (nonZero) rowsRaw.push(row);
  }

  // No equality constraints → all-positive direction is feasible.
  // Default: equal weights for all recipes.
  if (rowsRaw.length === 0) {
    return new Array<number>(n).fill(1);
  }

  // Gaussian elimination to row-echelon form, tracking pivot columns.
  const k = rowsRaw.length;
  const m = new Array<number[]>(k);
  for (let i = 0; i < k; i++) m[i] = rowsRaw[i].slice();

  const pivotCols: number[] = [];
  let row = 0;
  let col = 0;
  while (row < k && col < n) {
    // Find pivot.
    let pivot = row;
    let pivotAbs = Math.abs(m[pivot][col]);
    for (let r = row + 1; r < k; r++) {
      const v = Math.abs(m[r][col]);
      if (v > pivotAbs) {
        pivot = r;
        pivotAbs = v;
      }
    }
    if (pivotAbs <= NET_FLOW_EPSILON) {
      col += 1;
      continue;
    }
    if (pivot !== row) {
      const tmp = m[row];
      m[row] = m[pivot];
      m[pivot] = tmp;
    }
    // Eliminate above and below to get reduced row-echelon form.
    for (let r = 0; r < k; r++) {
      if (r === row) continue;
      const factor = m[r][col] / m[row][col];
      if (Math.abs(factor) <= NET_FLOW_EPSILON) continue;
      for (let c = col; c < n; c++) {
        m[r][c] -= factor * m[row][c];
      }
    }
    pivotCols.push(col);
    row += 1;
    col += 1;
  }

  const rank = pivotCols.length;
  if (rank >= n) return null; // Only zero solution.

  // Identify free columns (non-pivot columns).
  const isPivot = new Set(pivotCols);
  const freeCols: number[] = [];
  for (let c = 0; c < n; c++) if (!isPivot.has(c)) freeCols.push(c);

  // Build the first null-space basis vector: set the first free column
  // to 1, other free columns to 0, then back-substitute for pivot columns.
  const direction = new Array<number>(n).fill(0);
  direction[freeCols[0]] = 1;
  // For each pivot row, the pivot column variable is determined by the
  // free column choices. m[row][pivotCol] * x_pivot + sum(m[row][c] * x_c
  // for c in free) = 0 → x_pivot = -sum(...) / m[row][pivotCol].
  for (let r = 0; r < rank; r++) {
    const pivotCol = pivotCols[r];
    let sum = 0;
    for (const fc of freeCols) {
      sum += m[r][fc] * direction[fc];
    }
    direction[pivotCol] = -sum / m[r][pivotCol];
  }

  // Sign-fix: if all non-zero components share a sign, normalise to
  // positive. If mixed signs, the variant has no strictly-positive ray
  // → reject.
  let hasPos = false;
  let hasNeg = false;
  for (const v of direction) {
    if (v > NET_FLOW_EPSILON) hasPos = true;
    else if (v < -NET_FLOW_EPSILON) hasNeg = true;
  }
  if (hasPos && hasNeg) return null;
  if (hasNeg) {
    for (let i = 0; i < n; i++) direction[i] = -direction[i];
  }

  // Normalise so max component = 1.
  let maxAbs = 0;
  for (const v of direction) if (v > maxAbs) maxAbs = v;
  if (maxAbs <= NET_FLOW_EPSILON) return null;
  for (let i = 0; i < n; i++) direction[i] /= maxAbs;

  // Clamp tiny negatives to zero (FP noise).
  for (let i = 0; i < n; i++) {
    if (direction[i] < 0) direction[i] = 0;
  }

  // Verify the direction respects the variant's classifications.
  // For each item: net flow at the canonical direction must match the
  // declared regime (internal = 0, external-in < 0, external-out > 0).
  // Catches cases where the picked null-space basis vector implies
  // flows inconsistent with the regime (e.g., a free dimension chose
  // y_LX=1, y_XE=0 but the variant declared "liq_xiranite external-in"
  // which requires LX < XE).
  for (const [itemId, kind] of classification.entries()) {
    const row = coeffs.get(itemId);
    if (!row) continue;
    let net = 0;
    recipes.forEach((rid, i) => {
      const c = row.get(rid) ?? 0;
      net += c * direction[i];
    });
    if (kind === "internal") {
      if (Math.abs(net) > NET_FLOW_EPSILON) return null;
    } else if (kind === "external-in") {
      if (net > -NET_FLOW_EPSILON) return null;
    } else {
      if (net < NET_FLOW_EPSILON) return null;
    }
  }

  return direction;
};

/**
 * Enumerate every cap-feasible variant for a given (recipes, facility)
 * combination. Returns an empty array if the shape itself doesn't fit
 * the inner-slot budget, or if no regime satisfies the port caps.
 */
const buildBinShapeVariants = (
  recipes: Recipe[],
  facility: Facility,
  itemMap: Map<ItemId, Item>,
): BinShapeVariant[] => {
  const coeffsResult = buildItemCoefficients(recipes, facility);
  if (!coeffsResult) return [];
  const { coeffs, itemsTouched } = coeffsResult;
  const { alwaysIn, alwaysOut, borderline } = classifyItems(coeffs);

  // Fixed port costs from always-external items.
  let fixedLiqIn = 0;
  let fixedBeltIn = 0;
  let fixedLiqOut = 0;
  let fixedBeltOut = 0;
  for (const id of alwaysIn) {
    const isLiq = itemMap.get(id)?.isLiquid ?? false;
    if (isLiq) fixedLiqIn += 1;
    else fixedBeltIn += 1;
  }
  for (const id of alwaysOut) {
    const isLiq = itemMap.get(id)?.isLiquid ?? false;
    if (isLiq) fixedLiqOut += 1;
    else fixedBeltOut += 1;
  }
  void fixedBeltIn; // Belt-input variety is uncapped.

  // Quick reject: always-external items alone exceed caps.
  if (fixedLiqIn > facility.buffersIn.pipe.length) return [];
  if (fixedLiqOut > facility.buffersOut.pipe.length) return [];
  if (fixedBeltOut > facility.buffersOut.belt.length) return [];

  const sortedRecipeIds = recipes.map((r) => r.id).sort();
  const shapeIdPrefix = `${facility.id}:${sortedRecipeIds.join(",")}`;

  // Each borderline item has 3 choices: internal / external-in / external-out.
  // Total regimes: 3^k. For typical k ≤ 4 in real game data, that's ≤ 81.
  // Enumerate via DFS with cap-violation pruning to avoid useless work.
  const variants: BinShapeVariant[] = [];
  let nextVariantIdx = 0;

  const options: ItemClassification[] = ["internal", "external-in", "external-out"];

  const dfs = (
    pos: number,
    classification: Map<ItemId, ItemClassification>,
    liqIn: number,
    liqOut: number,
    beltOut: number,
  ) => {
    if (pos === borderline.length) {
      // Leaf: assemble variant if regime is parametrically feasible.
      // Build full classification map (always-* + borderline choices).
      const fullClass = new Map<ItemId, ItemClassification>(classification);
      for (const id of alwaysIn) fullClass.set(id, "external-in");
      for (const id of alwaysOut) fullClass.set(id, "external-out");

      const direction = computeVariantRateDirection(
        sortedRecipeIds,
        coeffs,
        fullClass,
      );
      if (!direction) return;

      const variantId = `${shapeIdPrefix}#v${nextVariantIdx++}`;
      variants.push({
        variantId,
        facility,
        recipeIds: sortedRecipeIds,
        rateDirection: direction,
        innerSlotsUsed: itemsTouched.size,
      });
      return;
    }

    const itemId = borderline[pos];
    const isLiq = itemMap.get(itemId)?.isLiquid ?? false;
    for (const opt of options) {
      let newLiqIn = liqIn;
      let newLiqOut = liqOut;
      let newBeltOut = beltOut;
      if (opt === "external-in") {
        if (isLiq) newLiqIn += 1;
        // Belt-in not capped.
      } else if (opt === "external-out") {
        if (isLiq) newLiqOut += 1;
        else newBeltOut += 1;
      }
      // Prune on cap violation.
      if (newLiqIn > facility.buffersIn.pipe.length) continue;
      if (newLiqOut > facility.buffersOut.pipe.length) continue;
      if (newBeltOut > facility.buffersOut.belt.length) continue;

      classification.set(itemId, opt);
      dfs(pos + 1, classification, newLiqIn, newLiqOut, newBeltOut);
      classification.delete(itemId);
    }
  };

  dfs(0, new Map(), fixedLiqIn, fixedLiqOut, fixedBeltOut);

  if (variants.length > VARIANT_COUNT_WARN_THRESHOLD && import.meta.env?.DEV) {
    console.warn(
      `[BIN_PACKING] Shape ${shapeIdPrefix} produced ${variants.length} variants ` +
        `(threshold ${VARIANT_COUNT_WARN_THRESHOLD}). Consider tightening enumeration.`,
    );
  }

  return variants;
};

/**
 * Enumerate every (shape, variant) pair across every (subset, facility)
 * combination. Uses DFS with inner-slot pruning to enumerate subsets,
 * and `buildBinShapeVariants` to enumerate regimes per subset.
 */
const enumerateAllVariants = (
  recipes: Recipe[],
  facility: Facility,
  itemMap: Map<ItemId, Item>,
): BinShapeVariant[] => {
  const innerSlots = facility.cacheSlots;
  if (innerSlots == null || recipes.length === 0) return [];

  const allVariants: BinShapeVariant[] = [];
  const itemsTouchedBy = recipes.map(
    (r) =>
      new Set([
        ...r.inputs.map((i) => i.itemId),
        ...r.outputs.map((o) => o.itemId),
      ]),
  );

  const dfs = (
    startIdx: number,
    chosen: number[],
    unionItems: Set<ItemId>,
  ) => {
    if (chosen.length > 0) {
      const subset = chosen.map((i) => recipes[i]);
      const variants = buildBinShapeVariants(subset, facility, itemMap);
      allVariants.push(...variants);
    }

    for (let i = startIdx; i < recipes.length; i++) {
      const itemsAfter = new Set(unionItems);
      for (const id of itemsTouchedBy[i]) itemsAfter.add(id);
      if (itemsAfter.size > innerSlots) continue;
      chosen.push(i);
      dfs(i + 1, chosen, itemsAfter);
      chosen.pop();
    }
  };

  dfs(0, [], new Set());
  return allVariants;
};

/**
 * Build the recipe-pool used by Phase 3: every distinct recipe that
 * either has positive Phase 2 slot demand OR is an equivalent (same
 * signature) twin of one that does.
 *
 * Twins matter because Phase 2's LP picks one variant of each pool
 * recipe (typically `_1` for power minimisation pre-grouping), but
 * Phase 3 should consider both `_1` and `_2` so it can pack into
 * the larger variant when beneficial.
 */
type EquivalenceClass = {
  slotDemand: number;
  alternatives: Recipe[];
  canonicalRecipe: Recipe;
  /** Per-original-demand-recipe slot count, used to key allocations
   * by Phase 2's recipe id (not the physical twin chosen by the ILP). */
  demandByRecipeId: Map<RecipeId, number>;
};

const buildEquivalenceClasses = (
  recipeSlotDemands: Map<RecipeId, number>,
  recipeMap: Map<RecipeId, Recipe>,
): EquivalenceClass[] => {
  const allRecipes = Array.from(recipeMap.values());
  const visitedSignatures = new Map<string, number>();
  const classes: EquivalenceClass[] = [];

  for (const [recipeId, slotDemand] of recipeSlotDemands.entries()) {
    if (slotDemand <= SLOT_DEMAND_EPSILON) continue;
    const canonical = recipeMap.get(recipeId);
    if (!canonical) continue;
    const sig = recipeSignature(canonical);
    const existingIdx = visitedSignatures.get(sig);
    if (existingIdx !== undefined) {
      const cls = classes[existingIdx];
      cls.slotDemand += slotDemand;
      cls.demandByRecipeId.set(recipeId, slotDemand);
      continue;
    }
    visitedSignatures.set(sig, classes.length);
    classes.push({
      slotDemand,
      alternatives: findRecipeAlternatives(canonical, allRecipes),
      canonicalRecipe: canonical,
      demandByRecipeId: new Map([[recipeId, slotDemand]]),
    });
  }
  return classes;
};

/** Stable bin id derived from facility, recipe ids, and emit index. */
const makeBinId = (
  facilityId: FacilityId,
  recipeIds: RecipeId[],
  index: number,
): BinId => `bin-${facilityId}-${recipeIds.join("-")}-${index}` as BinId;

/**
 * Solve the LP that packs slot demands into variant-defined bins.
 *
 * Variables:
 *   - `x_v ∈ ℤ≥0` per variant: number of buildings of this variant.
 *   - `u_v ∈ ℝ≥0` per variant: scale factor for the variant's canonical
 *     rate direction. Active recipe rates are `u_v × rateDirection[r]`.
 *
 * Constraints:
 *   - Capacity: `u_v ≤ x_v` (capacity in units of "max-utilisation
 *     building"; the `rateDirection` is normalised so `max = 1`).
 *   - Demand coverage: for each equivalence class and each pinned
 *     demand-recipe, `Σ_v u_v × rateDirection[r] = demand_r` (strict
 *     equality). The LP must find a non-negative combination of
 *     variant directions whose weighted sum exactly matches Phase 2's
 *     demand vector — no over-production, no under-production.
 *
 * No explicit regime constraints are needed: each variant's rate
 * direction already respects its internal/external classification by
 * construction (computed from the null space of the equality matrix).
 *
 * Lex passes: minimise buildings → power → shape-size sum. No Pass 4
 * for over-provisioning: with strict equality, `Σ_v u_v × dir_v[r] =
 * demand_r` is binding and y is fully determined exactly (modulo
 * HiGHS's 1e-10 feasibility tolerance).
 */
type SolveOutput = {
  buildingCounts: Map<BinShapeVariant, number>;
  /** Per (variant, recipe) active slot count from the LP solution. */
  activeSlots: Map<BinShapeVariant, Map<RecipeId, number>>;
  totalBuildings: number;
  totalPower: number;
};

const solvePacking = async (
  variants: BinShapeVariant[],
  classes: EquivalenceClass[],
  recipeOverrides: Map<ItemId, RecipeId> | undefined,
  facilityCaps: ReadonlyMap<FacilityId, number> | undefined,
): Promise<SolveOutput | null> => {
  if (variants.length === 0 || classes.length === 0) {
    return {
      buildingCounts: new Map(),
      activeSlots: new Map(),
      totalBuildings: 0,
      totalPower: 0,
    };
  }

  // Variable naming: x_<varIdx> (integer building count), u_<varIdx>
  // (continuous scale factor for variant's rate direction).
  const xVarByVariant = new Map<BinShapeVariant, string>();
  const uVarByVariant = new Map<BinShapeVariant, string>();
  variants.forEach((v, vi) => {
    xVarByVariant.set(v, `x_${vi}`);
    uVarByVariant.set(v, `u_${vi}`);
  });

  type Model = {
    optimize: string;
    opType: "min";
    constraints: Record<string, { min?: number; max?: number; equal?: number }>;
    variables: Record<string, Record<string, number>>;
    /** Variables to treat as integer (x_v building counts always are). */
    ints: Record<string, 1>;
    /**
     * Hard runtime cap (seconds) passed through to HiGHS as
     * `time_limit`. Defense in depth against any pathological
     * problem; unreachable on current workloads, but cheap insurance.
     */
    options?: { timeLimitSeconds?: number };
  };

  /**
   * Solver runtime cap (seconds) applied to every lex pass. 30 s
   * matches vitest's `testTimeout` in `vite.config.ts`; any longer
   * would break CI.
   */
  const SOLVER_TIME_LIMIT_SECONDS = 30;

  const variables: Model["variables"] = {};
  const constraints: Model["constraints"] = {};
  const ints: Model["ints"] = {};

  // Initialise variable coefficient blocks. x carries the building/
  // power/shape-size weights; u has no objective contribution.
  //
  // Integer x is the structurally-correct formulation (buildings are
  // physical). We solve as integer MIP when the variant count is
  // tractable; for very large problems (40+ variants and complex
  // demand structure) we fall back to continuous-relaxation + round-
  // up below.
  for (const v of variants) {
    const xName = xVarByVariant.get(v)!;
    variables[xName] = {
      buildings: 1,
      power: v.facility.powerConsumption,
      shape_size: v.recipeIds.length,
    };
    ints[xName] = 1;
    const uName = uVarByVariant.get(v)!;
    variables[uName] = {};
  }

  // Integer MIP always. HiGHS handles MIPs within budget on our
  // workloads (typical solves well under 1 s for ~30-variant plans).
  const lpInts: Model["ints"] = ints;

  let cIdx = 0;

  // Capacity: u_v ≤ x_v. Since rate direction is normalised so
  // max = 1, this bounds active rates by the building count.
  for (const v of variants) {
    const xName = xVarByVariant.get(v)!;
    const uName = uVarByVariant.get(v)!;
    const cName = `cap_${cIdx++}`;
    constraints[cName] = { max: 0 };
    variables[uName][cName] = 1;
    variables[xName][cName] = -1;
  }

  // Facility placement caps: for each capped facility F,
  // Σ_{v: v.facility.id === F} x_v ≤ N_F. Twin facilities (MIX_POOL_1
  // / MIX_POOL_2 sharing recipes) each carry their own cap; the MIP
  // shifts demand to the cheaper feasible facility automatically.
  //
  // Only emit a constraint if at least one variant uses the capped
  // facility — defensive against caps for facilities not present in
  // the plan.
  if (facilityCaps && facilityCaps.size > 0) {
    const variantsByFacility = new Map<FacilityId, BinShapeVariant[]>();
    for (const v of variants) {
      const fid = v.facility.id;
      let bucket = variantsByFacility.get(fid);
      if (!bucket) {
        bucket = [];
        variantsByFacility.set(fid, bucket);
      }
      bucket.push(v);
    }
    for (const [facilityId, cap] of facilityCaps) {
      const facilityVariants = variantsByFacility.get(facilityId);
      if (!facilityVariants || facilityVariants.length === 0) continue;
      if (!Number.isFinite(cap) || cap < 0) continue;
      const cName = `facility_cap_${facilityId}`;
      constraints[cName] = { max: cap };
      for (const v of facilityVariants) {
        const xName = xVarByVariant.get(v)!;
        variables[xName][cName] = 1;
      }
    }
  }

  // Demand coverage. Per equivalence class:
  //
  //   1. Per-pin restricted: for each pinned demand recipe, sum across
  //      variants containing that pin of `u_v × rateDirection[pin]`
  //      must be ≥ the pin's demand.
  //   2. Class-wide total: sum across all (variant, class-member)
  //      pairs of `u_v × rateDirection[r]` must be ≥ class's total
  //      slot demand.
  //
  // If any class or pin has no available variants, the LP is structurally
  // infeasible — fall back early.
  for (let classIdx = 0; classIdx < classes.length; classIdx++) {
    const cls = classes[classIdx];
    const classRecipeIds = new Set<RecipeId>(cls.alternatives.map((r) => r.id));

    const pinnedDemandIds = new Set<RecipeId>();
    if (recipeOverrides) {
      for (const overrideRecipeId of recipeOverrides.values()) {
        if (cls.demandByRecipeId.has(overrideRecipeId)) {
          pinnedDemandIds.add(overrideRecipeId);
        }
      }
    }

    // Per-pin restricted.
    for (const pinId of pinnedDemandIds) {
      const pinDemand = cls.demandByRecipeId.get(pinId) ?? 0;
      if (pinDemand <= SLOT_DEMAND_EPSILON) continue;
      let hasAnyVar = false;
      for (const v of variants) {
        if (v.recipeIds.includes(pinId)) {
          hasAnyVar = true;
          break;
        }
      }
      if (!hasAnyVar) return null;

      const cName = `cls_${classIdx}_pin_${pinId}`;
      constraints[cName] = { equal: pinDemand };
      for (const v of variants) {
        const recipeIdx = v.recipeIds.indexOf(pinId);
        if (recipeIdx < 0) continue;
        const coeff = v.rateDirection[recipeIdx];
        if (coeff <= NET_FLOW_EPSILON) continue;
        const uName = uVarByVariant.get(v)!;
        variables[uName][cName] = (variables[uName][cName] ?? 0) + coeff;
      }
    }

    // Class-wide total.
    let hasAnyClassVar = false;
    for (const v of variants) {
      for (const rid of v.recipeIds) {
        if (classRecipeIds.has(rid)) {
          hasAnyClassVar = true;
          break;
        }
      }
      if (hasAnyClassVar) break;
    }
    if (!hasAnyClassVar) return null;

    const cName = `cls_${classIdx}_total`;
    constraints[cName] = { equal: cls.slotDemand };
    for (const v of variants) {
      const uName = uVarByVariant.get(v)!;
      v.recipeIds.forEach((rid, ri) => {
        if (!classRecipeIds.has(rid)) return;
        const coeff = v.rateDirection[ri];
        if (coeff <= NET_FLOW_EPSILON) return;
        variables[uName][cName] = (variables[uName][cName] ?? 0) + coeff;
      });
    }
  }

  // Pass 1: minimise total buildings.
  const passOne: Model = {
    optimize: "buildings",
    opType: "min",
    constraints,
    variables,
    ints: lpInts,
    options: { timeLimitSeconds: SOLVER_TIME_LIMIT_SECONDS },
  };
  let r1: Record<string, number | boolean | undefined>;
  try {
    r1 = await highsSolve(passOne as LPModel);
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.warn("[BIN_PACKING] pass-1 solver threw:", e);
    }
    return null;
  }
  if (r1.feasible !== true || r1.bounded === false) {
    // Equality demand constraints can be infeasible if Phase 2's demand
    // ratios fall outside the conic hull of available variant
    // directions. We've already verified that every class & pin has at
    // least one containing variant (early-out checks above), so this
    // case means the demand vector itself can't be exactly hit by any
    // non-negative combination — a real data-driven anomaly.
    //
    // In test mode we throw to surface this loudly (it shouldn't
    // happen on current game data; if it does, either the recipes
    // changed or the packer has a real bug). In dev we warn. In
    // production we silently return null so packBins falls back to
    // emitting all-singleton bins (always exact-match feasible per
    // recipe, since each singleton's direction is a unit vector).
    const demandSummary = classes
      .map((cls, i) => `cls${i}=${cls.slotDemand.toFixed(3)}`)
      .join(", ");
    const message =
      `[BIN_PACKING] pass-1 ${r1.feasible !== true ? "infeasible" : "unbounded"} ` +
      `under strict-equality demand constraints. ` +
      `${variants.length} variants, ${classes.length} classes ` +
      `(demands: ${demandSummary}). ` +
      `Phase 2's demand ratios fall outside the conic hull of available variant ` +
      `directions; falling back to per-recipe singletons.`;
    if (import.meta.env?.MODE === "test") {
      throw new Error(message);
    }
    if (import.meta.env?.DEV) {
      console.warn(message);
    }
    return null;
  }

  if (typeof r1.result !== "number" || !Number.isFinite(r1.result)) {
    if (import.meta.env?.DEV) {
      console.warn(
        "[BIN_PACKING] pass-1 returned a non-finite objective; aborting",
        r1.result,
      );
    }
    return null;
  }
  const buildingsOpt = r1.result;

  // Pass 2: minimise power subject to building cap.
  const passTwo: Model = {
    optimize: "power",
    opType: "min",
    constraints: {
      ...constraints,
      buildings_cap: { max: buildingsOpt + LEX_BUILDINGS_TOLERANCE },
    },
    variables: {},
    ints: lpInts,
    options: { timeLimitSeconds: SOLVER_TIME_LIMIT_SECONDS },
  };
  for (const [varName, coefs] of Object.entries(variables)) {
    passTwo.variables[varName] = { ...coefs };
    if (varName.startsWith("x_")) {
      passTwo.variables[varName].buildings_cap = 1;
    }
  }
  let r2: Record<string, number | boolean | undefined>;
  let pass2Succeeded = true;
  try {
    r2 = await highsSolve(passTwo as LPModel);
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.warn("[BIN_PACKING] pass-2 solver threw:", e);
    }
    r2 = r1;
    pass2Succeeded = false;
  }
  if (r2.feasible !== true || r2.bounded === false) {
    if (import.meta.env?.DEV) {
      console.warn(
        "[BIN_PACKING] pass-2 infeasible/unbounded, falling back to pass-1",
      );
    }
    r2 = r1;
    pass2Succeeded = false;
  }

  // Pass 3: minimise shape-size sum subject to building + power caps.
  // Tie-breaks equally-priced packings toward less over-provisioning.
  let finalResult = r2;
  if (
    pass2Succeeded &&
    typeof r2.result === "number" &&
    Number.isFinite(r2.result)
  ) {
    const powerOpt = r2.result;
    const passThree: Model = {
      optimize: "shape_size",
      opType: "min",
      constraints: {
        ...constraints,
        buildings_cap: { max: buildingsOpt + LEX_BUILDINGS_TOLERANCE },
        power_cap: { max: powerOpt + LEX_POWER_TOLERANCE },
      },
      variables: {},
      ints: lpInts,
      options: { timeLimitSeconds: SOLVER_TIME_LIMIT_SECONDS },
    };
    for (const [varName, coefs] of Object.entries(variables)) {
      passThree.variables[varName] = { ...coefs };
      if (varName.startsWith("x_")) {
        passThree.variables[varName].buildings_cap = 1;
        passThree.variables[varName].power_cap = coefs.power;
      }
    }
    let r3: Record<string, number | boolean | undefined>;
    try {
      r3 = await highsSolve(passThree as LPModel);
    } catch (e) {
      if (import.meta.env?.DEV) {
        console.warn(
          "[BIN_PACKING] pass-3 solver threw, falling back to pass-2:",
          e,
        );
      }
      r3 = r2;
    }
    if (r3.feasible !== true || r3.bounded === false) {
      if (import.meta.env?.DEV) {
        console.warn(
          `[BIN_PACKING] pass-3 ${r3.bounded === false ? "unbounded" : "infeasible"} after lex caps; falling back to pass-2`,
        );
      }
      r3 = r2;
    }
    finalResult = r3;
  }

  // Extract x's and u's from the final result. Under strict-equality
  // demand constraints and integer MIP, `x_v` is integer and
  // `y_r = Σ u_v × dir_v[r] = demand_r` exactly for every recipe r.
  // The Math.ceil on `x` below is a strict-integer no-op kept as
  // a defensive guard against any 1e-10-scale FP drift.
  const buildingCounts = new Map<BinShapeVariant, number>();
  const activeSlots = new Map<BinShapeVariant, Map<RecipeId, number>>();
  let totalBuildings = 0;
  let totalPower = 0;
  for (const v of variants) {
    const xName = xVarByVariant.get(v)!;
    const x = finalResult[xName];
    if (typeof x !== "number" || x <= SLOT_DEMAND_EPSILON) continue;

    const uName = uVarByVariant.get(v)!;
    const u = finalResult[uName];
    if (typeof u !== "number" || u <= SLOT_DEMAND_EPSILON) continue;

    const count = Math.ceil(x - SLOT_DEMAND_EPSILON);
    if (count <= 0) continue;
    buildingCounts.set(v, count);
    totalBuildings += count;
    totalPower += count * v.facility.powerConsumption;

    const perRecipe = new Map<RecipeId, number>();
    v.recipeIds.forEach((rid, ri) => {
      const rate = u * v.rateDirection[ri];
      if (rate > SLOT_DEMAND_EPSILON) perRecipe.set(rid, rate);
    });
    activeSlots.set(v, perRecipe);
  }

  return { buildingCounts, activeSlots, totalBuildings, totalPower };
};

/**
 * Map a physical recipe id (potentially a `_2` twin chosen by the LP)
 * back to a Phase-2 demand recipe id. When multiple demand-recipe ids
 * map to the same physical recipe (e.g., LP picked `lx_2` and both
 * `lx_1` and `lx_2` have demand), we distribute proportionally.
 *
 * Returns a list of (demandRecipeId, slot fraction) entries summing to
 * the input slot count. The mapping is deterministic, driven by class
 * membership and (alphabetical) demand-recipe id order with pinned
 * demands prioritised.
 */
const mapPhysicalToDemandIds = (
  physicalRecipeId: RecipeId,
  totalSlots: number,
  classes: EquivalenceClass[],
  recipeOverrides: Map<ItemId, RecipeId> | undefined,
): Array<{ demandRecipeId: RecipeId; slots: number }> => {
  // Find the class containing this physical recipe.
  let owningClass: EquivalenceClass | undefined;
  for (const cls of classes) {
    if (cls.alternatives.some((r) => r.id === physicalRecipeId)) {
      owningClass = cls;
      break;
    }
  }
  if (!owningClass) {
    // No class — treat as a direct demand-recipe.
    return [{ demandRecipeId: physicalRecipeId, slots: totalSlots }];
  }

  // Pinned demand-recipes in this class get first claim.
  const pinnedDemandIds = new Set<RecipeId>();
  if (recipeOverrides) {
    for (const overrideRecipeId of recipeOverrides.values()) {
      if (owningClass.demandByRecipeId.has(overrideRecipeId)) {
        pinnedDemandIds.add(overrideRecipeId);
      }
    }
  }

  // Sort demand-recipes: pinned first (alphabetical within), then unpinned.
  const sorted = [...owningClass.demandByRecipeId.entries()].sort(
    ([a], [b]) => {
      const aPinned = pinnedDemandIds.has(a);
      const bPinned = pinnedDemandIds.has(b);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    },
  );

  // For pinned demand-recipes whose physical recipe matches `physicalRecipeId`,
  // they consume their full demand first. Then the remaining slots cover
  // unpinned demand-recipes in the class.
  const result: Array<{ demandRecipeId: RecipeId; slots: number }> = [];
  let remaining = totalSlots;

  // Phase 1: pinned demand-recipes whose pin equals `physicalRecipeId`.
  for (const [demandId, demand] of sorted) {
    if (remaining <= SLOT_DEMAND_EPSILON) break;
    if (!pinnedDemandIds.has(demandId)) continue;
    if (demandId !== physicalRecipeId) continue;
    const take = Math.min(demand, remaining);
    if (take > SLOT_DEMAND_EPSILON) {
      result.push({ demandRecipeId: demandId, slots: take });
      remaining -= take;
    }
  }

  // Phase 2: unpinned demand-recipes (alphabetical).
  for (const [demandId, demand] of sorted) {
    if (remaining <= SLOT_DEMAND_EPSILON) break;
    if (pinnedDemandIds.has(demandId)) continue;
    const take = Math.min(demand, remaining);
    if (take > SLOT_DEMAND_EPSILON) {
      result.push({ demandRecipeId: demandId, slots: take });
      remaining -= take;
    }
  }

  // Phase 3: leftover slots (e.g. ILP over-provisioned the class) get
  // attributed to the lowest-priority demand-recipe in the class.
  if (remaining > SLOT_DEMAND_EPSILON && sorted.length > 0) {
    const lastDemandId = sorted[sorted.length - 1][0];
    const existing = result.find((e) => e.demandRecipeId === lastDemandId);
    if (existing) existing.slots += remaining;
    else result.push({ demandRecipeId: lastDemandId, slots: remaining });
  }

  return result;
};

/**
 * Materialise `Bin[]` directly from the LP solution. Each variant with
 * x_v > 0 becomes one bin (containing all buildings of that variant);
 * the bin's external/internal flows are computed from the actual active
 * slot rates (`u_v × rateDirection[r]` per recipe), which under strict-
 * equality demand constraints exactly match Phase 2's demand.
 *
 * `bin.recipeIds` is populated with Phase-2 demand recipe ids (not the
 * physical twins the LP picked), via `mapPhysicalToDemandIds`.
 */
const emitBinsFromSolution = (
  buildingCounts: Map<BinShapeVariant, number>,
  activeSlots: Map<BinShapeVariant, Map<RecipeId, number>>,
  classes: EquivalenceClass[],
  recipeMap: Map<RecipeId, Recipe>,
  itemMap: Map<ItemId, Item>,
  recipeOverrides: Map<ItemId, RecipeId> | undefined,
): { bins: Bin[]; allocations: Map<RecipeId, RecipeBinAllocation> } => {
  // Deterministic order: facility id → recipe-set size desc → variant id.
  const sortedVariants = Array.from(buildingCounts.keys()).sort((a, b) => {
    if (a.facility.id !== b.facility.id) {
      return a.facility.id < b.facility.id ? -1 : 1;
    }
    if (a.recipeIds.length !== b.recipeIds.length) {
      return b.recipeIds.length - a.recipeIds.length;
    }
    return a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0;
  });

  const bins: Bin[] = [];
  const allocations = new Map<RecipeId, RecipeBinAllocation>();
  let emitIdx = 0;

  for (const variant of sortedVariants) {
    const count = buildingCounts.get(variant) ?? 0;
    if (count <= 0) continue;
    const physicalActive = activeSlots.get(variant) ?? new Map();

    // Map each physical recipe's active slots to demand-recipe ids.
    const demandActive = new Map<RecipeId, number>();
    for (const [physicalRid, slots] of physicalActive.entries()) {
      const mapping = mapPhysicalToDemandIds(
        physicalRid,
        slots,
        classes,
        recipeOverrides,
      );
      for (const e of mapping) {
        demandActive.set(
          e.demandRecipeId,
          (demandActive.get(e.demandRecipeId) ?? 0) + e.slots,
        );
      }
    }

    const demandIds = Array.from(demandActive.keys()).sort();
    if (demandIds.length === 0) continue;

    // Compute external/internal flows from the variant's classification
    // and the actual active slot counts. Mirrors the variant's regime.
    const netRates = new Map<ItemId, number>();
    for (const [physicalRid, slots] of physicalActive.entries()) {
      const recipe = recipeMap.get(physicalRid);
      if (!recipe) continue;
      for (const inp of recipe.inputs) {
        netRates.set(
          inp.itemId,
          (netRates.get(inp.itemId) ?? 0) -
            calcRate(inp.amount, recipe.craftingTime) * slots,
        );
      }
      for (const out of recipe.outputs) {
        netRates.set(
          out.itemId,
          (netRates.get(out.itemId) ?? 0) +
            calcRate(out.amount, recipe.craftingTime) * slots,
        );
      }
    }

    const externalInputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }> = [];
    const externalOutputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }> = [];
    const internalItems: ItemId[] = [];
    for (const [itemId, net] of netRates.entries()) {
      const isLiquid = itemMap.get(itemId)?.isLiquid ?? false;
      if (Math.abs(net) <= NET_FLOW_EPSILON) {
        internalItems.push(itemId);
      } else if (net < 0) {
        externalInputs.push({ itemId, rate: -net, isLiquid });
      } else {
        externalOutputs.push({ itemId, rate: net, isLiquid });
      }
    }
    const byItemId = (a: { itemId: ItemId }, b: { itemId: ItemId }) =>
      a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
    externalInputs.sort(byItemId);
    externalOutputs.sort(byItemId);
    internalItems.sort();

    const binId = makeBinId(variant.facility.id, demandIds, emitIdx++);
    bins.push({
      id: binId,
      facilityId: variant.facility.id,
      recipeIds: demandIds,
      buildingCount: count,
      externalInputs,
      externalOutputs,
      internalItems,
      // Populated post-pack in calculator.ts via SCC propagation.
      prefillCandidates: [],
      innerSlotsUsed: variant.innerSlotsUsed,
      isGrouped: demandIds.length >= 2,
      variantId: variant.variantId,
    });

    // Build allocations: each demand-recipe's slot share in this bin.
    for (const [demandRid, slots] of demandActive.entries()) {
      let alloc = allocations.get(demandRid);
      if (!alloc) {
        alloc = { recipeId: demandRid, totalSlots: 0, perBin: [] };
        allocations.set(demandRid, alloc);
      }
      alloc.totalSlots += slots;
      alloc.perBin.push({ binId, slots });
    }
  }

  return { bins, allocations };
};

/**
 * Emit trivial singleton bins for non-multi-formula recipes. This keeps
 * downstream consumers' data shape uniform: every active recipe has at
 * least one bin in the output.
 */
const emitSingletonBins = (
  recipeSlotDemands: Map<RecipeId, number>,
  packedAllocations: Map<RecipeId, RecipeBinAllocation>,
  recipeMap: Map<RecipeId, Recipe>,
  facilityMap: Map<FacilityId, Facility>,
  itemMap: Map<ItemId, Item>,
): { bins: Bin[]; allocations: Map<RecipeId, RecipeBinAllocation> } => {
  const bins: Bin[] = [];
  const allocations = new Map<RecipeId, RecipeBinAllocation>();
  let idx = 0;

  for (const [recipeId, slotDemand] of recipeSlotDemands.entries()) {
    if (slotDemand <= SLOT_DEMAND_EPSILON) continue;
    if (packedAllocations.has(recipeId)) continue;
    const recipe = recipeMap.get(recipeId);
    if (!recipe) continue;
    const facility = facilityMap.get(recipe.facilityId);
    if (!facility) continue;

    const inputs = recipe.inputs.map((i) => ({
      itemId: i.itemId,
      rate: calcRate(i.amount, recipe.craftingTime) * slotDemand,
      isLiquid: itemMap.get(i.itemId)?.isLiquid ?? false,
    }));
    const outputs = recipe.outputs.map((o) => ({
      itemId: o.itemId,
      rate: calcRate(o.amount, recipe.craftingTime) * slotDemand,
      isLiquid: itemMap.get(o.itemId)?.isLiquid ?? false,
    }));
    const innerSlotsUsed = new Set([
      ...recipe.inputs.map((i) => i.itemId),
      ...recipe.outputs.map((o) => o.itemId),
    ]).size;

    const id = makeBinId(facility.id, [recipeId], idx++);
    // Trivial singleton variant id: matches the multi-formula scheme
    // for consistent downstream identification.
    const variantId = `${facility.id}:${recipeId}#v0`;
    bins.push({
      id,
      facilityId: facility.id,
      recipeIds: [recipeId],
      buildingCount: slotDemand,
      externalInputs: inputs,
      externalOutputs: outputs,
      internalItems: [],
      // Populated post-pack in calculator.ts via SCC propagation.
      prefillCandidates: [],
      innerSlotsUsed,
      isGrouped: false,
      variantId,
    });
    allocations.set(recipeId, {
      recipeId,
      totalSlots: slotDemand,
      perBin: [{ binId: id, slots: slotDemand }],
    });
  }

  return { bins, allocations };
};

/**
 * Identify recipe-override pins that have no valid bin shape on their
 * facility. These pins force `solvePacking` into infeasibility — the
 * packer falls back to per-recipe singletons, losing grouping
 * benefits. Returns a list of human-readable warning strings (one per
 * problematic pin) so the UI can surface them to the user.
 */
const buildInfeasiblePinWarnings = (
  recipeOverrides: Map<ItemId, RecipeId> | undefined,
  recipeSlotDemands: Map<RecipeId, number>,
  recipeMap: Map<RecipeId, Recipe>,
  facilityMap: Map<FacilityId, Facility>,
  itemMap: Map<ItemId, Item>,
): PlanWarning[] => {
  if (!recipeOverrides || recipeOverrides.size === 0) return [];
  const warnings: PlanWarning[] = [];
  const seenPins = new Set<RecipeId>();

  for (const overrideRecipeId of recipeOverrides.values()) {
    if (seenPins.has(overrideRecipeId)) continue;
    seenPins.add(overrideRecipeId);
    if ((recipeSlotDemands.get(overrideRecipeId) ?? 0) <= SLOT_DEMAND_EPSILON) {
      continue;
    }
    const recipe = recipeMap.get(overrideRecipeId);
    if (!recipe) continue;
    const facility = facilityMap.get(recipe.facilityId);
    if (facility?.cacheSlots == null) continue;
    const recipesOnFac: Recipe[] = [];
    for (const r of recipeMap.values()) {
      if (r.facilityId !== facility.id) continue;
      if (recipeSignature(r) !== recipeSignature(recipe)) continue;
      recipesOnFac.push(r);
    }
    for (const r of recipeMap.values()) {
      if (r.facilityId !== facility.id) continue;
      if (recipesOnFac.some((x) => x.id === r.id)) continue;
      if (
        recipesOnFac.some((x) => recipeSignature(x) === recipeSignature(r))
      ) {
        recipesOnFac.push(r);
      }
    }
    const variants = enumerateAllVariants(recipesOnFac, facility, itemMap);
    const hasVariant = variants.some((v) =>
      v.recipeIds.includes(overrideRecipeId),
    );
    if (!hasVariant) {
      warnings.push({
        kind: "packer-override-infeasible",
        recipeId: overrideRecipeId,
        facilityId: facility.id,
      });
    }
  }

  return warnings;
};

/**
 * Test-mode invariant: every emitted bin must satisfy its facility's
 * port caps. Throws in test mode (`import.meta.env?.MODE === "test"`);
 * warns in dev; no-op in production. Mirrors the
 * `assertFlowIntegrity` pattern in `flow-assertions.ts`.
 *
 * Only called on bins emitted from the variant-LP path
 * (`emitBinsFromSolution`) where caps are guaranteed by construction.
 * The infeasibility-fallback path (`emitSingletonBins` after LP failure)
 * may emit cap-violating bins — those represent genuinely-impossible
 * user configurations and are surfaced via `warnings` instead.
 *
 * Any violation surfaced here represents a packer bug — wrong variant
 * enumeration, mis-classified items, or LP rounding pushing a borderline
 * regime over its boundary.
 */
const assertBinPortCaps = (
  bins: Bin[],
  facilityMap: Map<FacilityId, Facility>,
): void => {
  const isTest = import.meta.env?.MODE === "test";
  const isDev = import.meta.env?.DEV;
  if (!isTest && !isDev) return;

  for (const bin of bins) {
    const facility = facilityMap.get(bin.facilityId);
    if (!facility) continue;
    // Singleton bins on single-formula facilities (no `cacheSlots`)
    // bypass cap checks — the facility was designed for that recipe.
    if (facility.cacheSlots == null) continue;

    const liqIn = bin.externalInputs.filter((i) => i.isLiquid).length;
    const liqOut = bin.externalOutputs.filter((o) => o.isLiquid).length;
    const beltOut = bin.externalOutputs.filter((o) => !o.isLiquid).length;

    const violations: string[] = [];
    if (liqIn > facility.buffersIn.pipe.length) {
      violations.push(
        `${liqIn} liquid-in items > ${facility.buffersIn.pipe.length} pipe-in cap`,
      );
    }
    if (liqOut > facility.buffersOut.pipe.length) {
      violations.push(
        `${liqOut} liquid-out items > ${facility.buffersOut.pipe.length} pipe-out cap`,
      );
    }
    if (beltOut > facility.buffersOut.belt.length) {
      violations.push(
        `${beltOut} belt-out items > ${facility.buffersOut.belt.length} belt-out cap`,
      );
    }
    if (violations.length === 0) continue;

    const message =
      `[BIN_PACKING] Bin ${bin.id} (variant ${bin.variantId}) on ${facility.id} ` +
      `violates port caps: ${violations.join("; ")}`;
    if (isTest) throw new Error(message);
    console.warn(message);
  }
};

/**
 * Phase 3 entry point. Returns bins + per-recipe allocations + warnings.
 */
/**
 * Post-packing per-facility cap check.
 *
 * Walks the FINAL emitted bin set (multi-formula MIP-packed bins PLUS
 * single-formula singleton bins), sums `buildingCount` per facility,
 * and emits one structured warning per facility exceeding its cap.
 *
 * Why post-packing instead of MIP-internal:
 *   - The MIP's variant set is restricted to multi-formula facilities
 *     (`facility.cacheSlots != null`). Single-formula facilities like
 *     `xiranite_oven_1` go through `emitSingletonBins` and bypass the
 *     MIP entirely — caps on them must still be checked.
 *   - One unified detection path beats two parallel ones.
 *
 * The MIP's cap constraint inside `solvePacking` is still useful: it
 * helps the MIP shift demand between twin facilities (e.g. MIX_POOL_1
 * ↔ MIX_POOL_2) before this warning ever fires. The warning is the
 * diagnostic when even the MIP can't fit.
 *
 * Caps are integers (parseInt-guarded at the UI input); `used` is
 * float-from-LP. Direct `used > cap + EPSILON` comparison; the
 * EPSILON absorbs LP solver drift. NO ceil on the comparison — that
 * would spuriously fire for fractional caps if those ever become
 * supported.
 */
const buildOverCapWarningsFromBins = (
  bins: readonly Bin[],
  facilityCaps: ReadonlyMap<FacilityId, number>,
): PlanWarning[] => {
  const usedByFacility = new Map<FacilityId, number>();
  for (const bin of bins) {
    usedByFacility.set(
      bin.facilityId,
      (usedByFacility.get(bin.facilityId) ?? 0) + bin.buildingCount,
    );
  }
  const warnings: PlanWarning[] = [];
  const EPSILON = 1e-9;
  for (const [facilityId, cap] of facilityCaps) {
    if (!Number.isFinite(cap) || cap < 0) continue;
    const used = usedByFacility.get(facilityId) ?? 0;
    if (used <= cap + EPSILON) continue;
    warnings.push({
      kind: "facility-over-cap",
      facilityId,
      used,
      cap,
    });
  }
  return warnings;
};

export const packBins = async (input: PackingInput): Promise<PackingResult> => {
  const {
    recipeSlotDemands,
    recipeMap,
    facilityMap,
    itemMap,
    recipeOverrides,
    facilityCaps,
  } = input;

  // Identify which recipes are eligible for multi-formula packing
  // (their facility has `cacheSlots` defined).
  const eligibleRecipeIds = new Set<RecipeId>();
  const eligibleFacilities = new Set<Facility>();
  for (const [recipeId, slotDemand] of recipeSlotDemands.entries()) {
    if (slotDemand <= SLOT_DEMAND_EPSILON) continue;
    const recipe = recipeMap.get(recipeId);
    if (!recipe) continue;
    const facility = facilityMap.get(recipe.facilityId);
    if (facility?.cacheSlots == null) continue;
    eligibleRecipeIds.add(recipeId);
    eligibleFacilities.add(facility);
    // Twins on other facilities (different facility, same signature) also
    // become candidates.
    for (const r of recipeMap.values()) {
      if (recipeSignature(r) !== recipeSignature(recipe)) continue;
      const f = facilityMap.get(r.facilityId);
      if (f?.cacheSlots != null) eligibleFacilities.add(f);
    }
  }

  // Build equivalence classes (one per recipe-signature with positive
  // demand). Each class accumulates slot demand from all twins.
  const classes = buildEquivalenceClasses(
    new Map(
      [...recipeSlotDemands.entries()].filter(([rid]) =>
        eligibleRecipeIds.has(rid),
      ),
    ),
    recipeMap,
  );

  // Enumerate variants per facility. The variants' recipes come from the
  // union of class alternatives hosted by that facility.
  const classRecipesByFacility = new Map<FacilityId, Recipe[]>();
  for (const facility of eligibleFacilities) {
    const recipesOnFac: Recipe[] = [];
    for (const cls of classes) {
      for (const r of cls.alternatives) {
        if (r.facilityId === facility.id) {
          recipesOnFac.push(r);
          break;
        }
      }
    }
    classRecipesByFacility.set(facility.id, recipesOnFac);
  }

  const allVariants: BinShapeVariant[] = [];
  for (const facility of eligibleFacilities) {
    const recipesOnFac = classRecipesByFacility.get(facility.id) ?? [];
    const variants = enumerateAllVariants(recipesOnFac, facility, itemMap);
    allVariants.push(...variants);
  }

  if (import.meta.env?.DEV) {
    console.log(
      `[BIN_PACKING] Enumerated ${allVariants.length} variants across ${eligibleFacilities.size} facilities`,
    );
  }

  // Try with caps first. If the cap-constrained MIP is infeasible,
  // retry without caps and emit warnings — the user gets a workable
  // plan plus a clear signal that their caps are exceeded. If even
  // the no-caps solve fails, fall through to the existing
  // singleton-bins fallback.
  //
  // Note: `solvePacking` throws in test mode when the pass-1 LP is
  // infeasible (a defensive check against real packer bugs on demand
  // ratios outside the conic hull). When caps are provided, the
  // infeasibility may simply be cap-induced — a legitimate user
  // configuration, not a bug. We catch and treat as "retry-worthy"
  // only when `facilityCaps` is non-empty; otherwise the throw
  // propagates as before.
  // Try with caps first. If the cap-constrained MIP throws (test-mode
  // safety net) or returns null AND caps were applied, retry without
  // caps. The post-packing cap check still fires on the retry's bins.
  // If even the no-caps solve fails, fall through to the singleton-bins
  // fallback path (which ALSO gets a post-packing cap check).
  let solution: SolveOutput | null = null;
  const hasCaps = !!(facilityCaps && facilityCaps.size > 0);
  try {
    solution = await solvePacking(
      allVariants,
      classes,
      recipeOverrides,
      facilityCaps,
    );
  } catch (e) {
    if (!hasCaps) throw e;
    // Cap-induced infeasibility — fall through to retry without caps.
    if (import.meta.env?.DEV) {
      console.warn(
        "[BIN_PACKING] Cap-constrained MIP threw (treating as cap-induced infeasibility):",
        e,
      );
    }
    solution = null;
  }
  if (!solution && hasCaps) {
    if (import.meta.env?.DEV) {
      console.warn(
        "[BIN_PACKING] Cap-constrained MIP failed; retrying without facility caps",
      );
    }
    solution = await solvePacking(
      allVariants,
      classes,
      recipeOverrides,
      undefined,
    );
  }

  if (!solution) {
    if (import.meta.env?.DEV) {
      console.warn(
        "[BIN_PACKING] LP failed; falling back to all-singleton bins",
      );
    }
    const warnings = buildInfeasiblePinWarnings(
      recipeOverrides,
      recipeSlotDemands,
      recipeMap,
      facilityMap,
      itemMap,
    );
    if (warnings.length === 0) {
      warnings.push({ kind: "packer-fallback" });
    }
    const fallback = emitSingletonBins(
      recipeSlotDemands,
      new Map(),
      recipeMap,
      facilityMap,
      itemMap,
    );
    // Cap check on the fallback singleton bins — caps still apply even
    // when the rest of the packing infrastructure has degraded.
    if (facilityCaps) {
      warnings.push(...buildOverCapWarningsFromBins(fallback.bins, facilityCaps));
    }
    // No port-cap assertion on the fallback path: it's a best-effort
    // singletonization for genuinely-infeasible scenarios; any cap
    // violations are surfaced via warnings.
    return {
      ...fallback,
      warnings,
    };
  }

  if (import.meta.env?.DEV) {
    console.log(
      `[BIN_PACKING] Solved: ${solution.totalBuildings} buildings, ${solution.totalPower}W`,
    );
  }

  const packed = emitBinsFromSolution(
    solution.buildingCounts,
    solution.activeSlots,
    classes,
    recipeMap,
    itemMap,
    recipeOverrides,
  );
  const singletons = emitSingletonBins(
    recipeSlotDemands,
    packed.allocations,
    recipeMap,
    facilityMap,
    itemMap,
  );

  // Only assert on packed.bins (variant-LP path) — those are guaranteed
  // cap-safe by construction. Singletons from `emitSingletonBins` are
  // a best-effort fallback for recipes the LP couldn't host (genuinely-
  // infeasible scenarios) and may legitimately violate caps; they're
  // surfaced via warnings rather than assertions.
  assertBinPortCaps(packed.bins, facilityMap);

  const combinedBins = [...packed.bins, ...singletons.bins];
  // Post-packing cap check on the FULL bin set. This catches:
  //   - Multi-formula facilities where the MIP cap was bypassed via
  //     retry-without-caps (cap was tight).
  //   - Single-formula facilities whose recipes flowed through
  //     `emitSingletonBins` and skipped the MIP entirely.
  const warnings: PlanWarning[] = facilityCaps
    ? buildOverCapWarningsFromBins(combinedBins, facilityCaps)
    : [];

  return {
    bins: combinedBins,
    allocations: new Map([...packed.allocations, ...singletons.allocations]),
    warnings,
  };
};
