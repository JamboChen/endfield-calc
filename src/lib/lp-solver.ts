/**
 * Generic LP wrapper around HiGHS (WASM).
 *
 * Callers supply a recipe set + per-item constraints (`equal`, `min`, or
 * `disposal-slack`); the solver returns a feasible facility-count
 * assignment that's **lex-optimal** under the `LEX_ORDER` objective
 * ranking (currently `rawCost → buildingCount → power`).
 *
 * Raw materials are excluded from balance constraints — they appear
 * only in the `rawCost` objective (infinite-supply assumption). Items
 * in `costlessRaws` further contribute 0 to that objective so the LP
 * doesn't bias against recipes that consume them.
 *
 * Used by `flow-solver.ts:calculateFlows` as the single solve over the
 * multi-recipe graph; see that file for the global-LP framing.
 */

import { calcRate } from "@/lib/utils";
import { solve as highsSolve } from "@/lib/highs-wrapper";
import type { ItemId, RecipeId, FacilityId, Recipe, Facility } from "@/types";

/** Numerical tolerance used for sign / equality checks against LP output. */
const LP_EPSILON = 1e-9;

/**
 * Facility-count clamp threshold applied in `extractSolution`. LP outputs
 * below this magnitude are treated as zero — accounts for HiGHS numerical
 * artefacts in degenerate cases (e.g. lex passes with ties or
 * floating-point drift near the cap constraints).
 *
 * Why higher than `LP_EPSILON`: the LP can occasionally land on a
 * "near-optimal" vertex with one alternative recipe at ~1e-8 facilities
 * (effectively zero throughput, ~3e-7 items/min) while the dominant
 * alternative carries the real load. Without this clamp, downstream
 * consumers (bin packer, mappers) see a phantom recipe with no edges.
 * 1e-6 is well above any sub-visible threshold (`MIN_VISIBLE_RATE_PER_MIN`
 * = 1e-3 items/min ≈ 3e-5 facilities at the slowest recipe rate) and
 * well below any meaningful facility count.
 */
const FACILITY_COUNT_EPSILON = 1e-6;

/**
 * Lexicographic objective ordering for `solveLP`. Each pass minimises one
 * objective subject to upper-bound constraints from all previous passes,
 * so the resulting solution is **lex-optimal** under this ranking:
 *   1. `rawCost` — total non-liquid raw material consumption per minute.
 *   2. `buildingCount` — total fractional facility count (Σ x_r).
 *   3. `power` — total power consumption per minute (gated by `MINIMIZE_POWER`).
 *
 * To disable the power pass (e.g. if it ever dominates solve time), set
 * `MINIMIZE_POWER = false`. The lex chain auto-shortens.
 */
type LexObjective = "rawCost" | "buildingCount" | "power";

const MINIMIZE_POWER = true;

const LEX_ORDER: readonly LexObjective[] = MINIMIZE_POWER
  ? (["rawCost", "buildingCount", "power"] as const)
  : (["rawCost", "buildingCount"] as const);

/**
 * Tiny buffer added to each lex pass's upper-bound constraint to absorb
 * library-level floating-point noise. The raw-cost tolerance is tight
 * (1e-6) because raw cost is the dominant lex term; the others are
 * looser since they're tie-breakers and small numerical drift across
 * vertex transitions can otherwise spuriously block feasibility.
 */
const LEX_TOLERANCE: Record<LexObjective, number> = {
  rawCost: 1e-6,
  buildingCount: 1e-3,
  power: 1e-3,
};

/**
 * Cost coefficient on disposal-slack variables in every objective.
 * Chosen large enough that LP strictly prefers solutions with slack = 0;
 * deficits in the result therefore reflect "no internal solution exists"
 * rather than "LP took the lazy path". 1e6 is far above any conceivable
 * per-facility cost in the current data set.
 */
const SLACK_PENALTY = 1e6;

/**
 * Tiny positive baseline added to each recipe's `power` cost so zero-power
 * recipes (or recipes whose facility lookup fails) remain bounded under
 * the power-minimization pass. Without this, LP could run such recipes
 * arbitrarily high without paying anything in the power pass.
 */
const POWER_COST_FLOOR = 1e-4;

export type LPItemConstraint = {
  /**
   * Strict equality: production - consumption = `rhs`. Use for items where
   * over-production has no sink (every unit must have a consumer).
   */
  type: "equal";
  rhs: number;
} | {
  /**
   * Lower bound: production - consumption ≥ `rhs`. Use for external output
   * demands (over-production allowed; surfaced via surplus indicator).
   */
  type: "min";
  rhs: number;
} | {
  /**
   * Strict-balance slack: `production - consumption + slack_def - slack_sur = rhs`
   * with both `slack_def, slack_sur ≥ 0` and `SLACK_PENALTY` on both in
   * every lex objective.
   *
   * Models forced-disposal items: production MUST match consumption (no
   * surplus, no deficit) because the byproduct has to physically go
   * somewhere — either a disposer recipe or a downstream consumer. Both
   * slacks are deviation reports, not flexibility levers:
   *   - `slack_def > 0` ⇒ deficit (consumers exist but producers can't
   *     satisfy them; e.g. user pinned a dismantle recipe whose
   *     corresponding FILLING recipe forms a closed cycle). Reported in
   *     `LPSolution.disposalDeficits`.
   *   - `slack_sur > 0` ⇒ surplus (producers exceed all disposer
   *     capacity; e.g. user capped Sewage Inlet at 0 and disabled the
   *     Liquid Cleaner). Reported in `LPSolution.disposalSurpluses`.
   *
   * Without surplus-slack, the LP would have no incentive to use
   * disposer recipes (they cost building + power; ignoring them keeps
   * the objective lower). With it, surplus is penalized at the same
   * scale as deficit, so the LP allocates disposers whenever they're
   * cheaper than the slack penalty (~always).
   */
  type: "disposal-slack";
  rhs: number;
};

export type LPInput = {
  /**
   * Recipes participating in the LP (typically every recipe in the
   * active subset of `graph.recipeNodes`).
   */
  recipes: Recipe[];
  /**
   * Constraints per item. The full set of items mentioned by any recipe's
   * inputs/outputs MUST appear here, otherwise the LP under-constrains the
   * solution. Items not relevant to local balance can use
   * `{ type: "min", rhs: 0 }`.
   */
  itemConstraints: Map<ItemId, LPItemConstraint>;
  /** Items that should contribute to the raw-cost objective. */
  rawMaterials: Set<ItemId>;
  /**
   * Subset of `rawMaterials` whose consumption is treated as **free** in
   * the `rawCost` objective. Liquid raws (water, acid) fall in here:
   * pickup is via Fluid Pumps with effectively unbounded throughput and
   * trivial power, so they shouldn't bias the LP against recipes that
   * happen to consume them (e.g. Yazhen planter water vs Buckflower
   * planter no-water). See `src/data/index.ts:costlessRaws`.
   */
  costlessRaws: ReadonlySet<ItemId>;
  /**
   * Per-(raw item) upper bound on aggregate consumption rate, in
   * items/min. **Optional**: absent or empty means no caps enforced.
   * Items NOT in this map are unconstrained — the LP treats them as
   * infinite-supply (the existing rawMaterials behaviour).
   *
   * For each `(itemId, cap)` entry, the LP gains a soft constraint
   *   `Σ (input_rate × x_recipe) ≤ cap + slack`,  slack ≥ 0
   * with `slack` penalized by `SLACK_PENALTY` in every lex objective.
   * The LP biases toward recipes that conserve the capped raw; if no
   * combination respects the cap, slack engages and the overage is
   * reported per-item in `LPSolution.rawCapOveruse`.
   *
   * Mirrors the disposal-slack pattern below. The two slack systems
   * coexist (separate variable namespaces, both penalized).
   */
  rawCaps?: ReadonlyMap<ItemId, number>;
  /**
   * Per-facility upper bound on total fractional facility count, in
   * buildings. **Optional**: absent or empty means no caps enforced.
   * Facilities NOT in this map are unconstrained.
   *
   * For each `(facilityId, cap)` entry the LP gains a SOFT constraint
   *   `Σ_{r : r.facilityId === facilityId} x_r ≤ cap + slack`,  slack ≥ 0
   * with `slack` penalized by `SLACK_PENALTY` in every lex objective.
   *
   * The penalty dominates real per-recipe cost by 3-5 orders of
   * magnitude, so the LP strictly prefers cap-respecting solutions
   * whenever an alternative producer exists: the lex objective picks
   * recipes that respect the cap up-front rather than leaving the
   * routing to the packer's post-hoc retry-without-caps fallback.
   * (Typical case: a capped Sewage Inlet's overflow is routed to the
   * uncapped Liquid Cleaner because Cleaner cost ≪ slack penalty.)
   *
   * When NO alternative producer is available the LP engages slack to
   * satisfy the target, returning a feasible (over-cap) plan. The
   * packer's existing MIP-cap path triggers its retry-without-caps
   * fallback, and `computeOverCapWarnings` (`plan-helpers.ts:277`)
   * surfaces the `facility-over-cap` warning at the hook layer.
   *
   * **Why not hard**: a hard cap returns LP-infeasible whenever target
   * demand exceeds `cap × throughput` and no alternative producer is
   * available — even though the packer's existing retry mechanism
   * would have produced a sensible (over-cap) plan. User-reported
   * regression: `xiranite_oven_1` capped at 2 with target = 6 Heavy
   * Xiranite/min requires 3 Forges (1 for the final recipe + 2 for
   * the upstream Xiranite Powder, both on `xiranite_oven_1`) → hard
   * cap returns infeasible and the user sees `[FAILED] Global LP
   * infeasible` instead of a plan with the over-cap warning.
   *
   * Mirrors the `rawCaps` slack pattern above. The two slack systems
   * coexist (separate variable namespaces; both excluded from lex caps;
   * both penalized in every lex pass).
   *
   * **Cap = 0 vs absence**: a `cap: 0` entry penalizes every use of
   * the facility (slack absorbs the full demand). For variant
   * facilities (e.g. `LIQUID_CLEAN_GATE_1`), the calc-side
   * `computeVariantExclusions` (`variant-filter.ts`) drops both
   * variants from the recipe set before the LP runs when cap = 0,
   * so the LP never engages slack for them. For non-variant
   * facilities, cap = 0 effectively forbids use unless no alternative
   * exists (in which case slack engages with very high penalty).
   */
  facilityCaps?: ReadonlyMap<FacilityId, number>;
  /** Facility lookup for power-cost computation. */
  facilityMap: Map<FacilityId, Facility>;
};

export type LPSolution = {
  feasible: true;
  facilityCounts: Map<RecipeId, number>;
  /** Per-item deficit to propagate to upstream producers (only populated for items with `type: "disposal-slack"` in the input). */
  disposalDeficits: Map<ItemId, number>;
  /**
   * Per-item surplus that couldn't be absorbed by any disposer (only
   * populated for items with `type: "disposal-slack"` in the input).
   * Indicates the LP wanted to dispose more than the available disposer
   * capacity allowed — typically caused by a facility cap binding
   * (e.g. LIQUID_CLEAN_GATE_1 capped at 3 but sewage produced exceeds 360/min
   * and Liquid Cleaner is unavailable in the current domain).
   *
   * Distinct from `disposalDeficits` (which is the opposite direction —
   * consumption exceeds production, e.g. a closed-cycle pin).
   */
  disposalSurpluses: Map<ItemId, number>;
  /**
   * Per-item raw-cap overage (slack value > LP_EPSILON), in items/min.
   * Only populated for items in `LPInput.rawCaps` where the LP engaged
   * slack because no recipe combination respected the cap.
   *
   * **Informational only — not the canonical warning source.** The
   * production `raw-over-cap` PlanWarnings come from post-pack
   * comparison of `stats.rawMaterialRequirements` against `rawCaps`
   * (in `plan-helpers.computeRawOverCapWarnings`); that source
   * reflects the integer-ceiled bin allocation while LP slack is
   * fractional and pre-packing. The two sources usually agree but
   * diverge by ceiling effects. Exposed here for tests and the dev-
   * mode logging in `flow-solver.ts`; production code should not
   * consume this directly.
   */
  rawCapOveruse: Map<ItemId, number>;
  totalRawCost: number;
  /**
   * Total fractional facility count (Σ x_r over recipe variables; slack
   * vars excluded). This is the pass-2 lex objective; reading it gives
   * the LP-side building-cost figure before bin-packer ceiling.
   */
  totalBuildingCount: number;
  totalPower: number;
};

export type LPFailure = {
  feasible: false;
  reason: "infeasible" | "unbounded" | "solver_error";
};

export type LPResult = LPSolution | LPFailure;

/**
 * Per-facility-per-minute raw consumption rate; sums inputs in
 * `rawMaterials` *excluding* `costlessRaws`. Costless raws (currently:
 * liquid water + liquid acid) are treated as infinite-supply AND
 * zero-cost in the LP objective so they don't bias selection against
 * recipes that consume them.
 *
 * The exclusion happens here on the input side only — raws never appear
 * as LP balance constraints anyway, so byproduct raws (e.g. acid emitted
 * by `liquid_purifier_copper_enr_1`) already had no LP value; symmetry
 * is preserved.
 */
const rawCostPerFacility = (
  recipe: Recipe,
  rawMaterials: Set<ItemId>,
  costlessRaws: ReadonlySet<ItemId>,
): number => {
  let cost = 0;
  for (const input of recipe.inputs) {
    if (!rawMaterials.has(input.itemId)) continue;
    if (costlessRaws.has(input.itemId)) continue;
    cost += calcRate(input.amount, recipe.craftingTime);
  }
  return cost;
};

/**
 * Build the LP variable's coefficient block for one recipe: per-item net
 * rate for each constraint, plus `rawCost` and `power` objective coefs.
 */
const buildVariableCoefficients = (
  recipe: Recipe,
  itemConstraintNames: Map<ItemId, string>,
  rawMaterials: Set<ItemId>,
  costlessRaws: ReadonlySet<ItemId>,
  facilityMap: Map<FacilityId, Facility>,
): Record<string, number> => {
  const coefs: Record<string, number> = {};

  for (const out of recipe.outputs) {
    const constraintName = itemConstraintNames.get(out.itemId);
    if (!constraintName) continue;
    coefs[constraintName] = (coefs[constraintName] ?? 0) +
      calcRate(out.amount, recipe.craftingTime);
  }
  for (const inp of recipe.inputs) {
    const constraintName = itemConstraintNames.get(inp.itemId);
    if (!constraintName) continue;
    coefs[constraintName] = (coefs[constraintName] ?? 0) -
      calcRate(inp.amount, recipe.craftingTime);
  }

  coefs.rawCost = rawCostPerFacility(recipe, rawMaterials, costlessRaws);
  // buildingCount: 1 per fractional facility, no floor needed (LP variables
  // are already non-negative; minimisation drives unnecessary recipes to 0).
  coefs.buildingCount = 1;
  const facility = facilityMap.get(recipe.facilityId);
  coefs.power = (facility?.powerConsumption ?? 0) + POWER_COST_FLOOR;

  return coefs;
};

type LPModel = {
  optimize: string;
  opType: "min";
  constraints: Record<string, { min?: number; max?: number; equal?: number }>;
  variables: Record<string, Record<string, number>>;
};

const buildModel = (
  input: LPInput,
  objective: LexObjective,
  /**
   * Upper-bound caps from previously-solved lex passes. Each entry adds a
   * `lex_cap_<obj>` constraint of `Σ coefs[obj] × x ≤ value + tolerance`
   * so the current pass cannot exceed the previously-optimal value of any
   * earlier objective. Slack vars are excluded from these caps to preserve
   * the documented slack semantics (see SLACK_PENALTY comment).
   */
  previousCaps: ReadonlyMap<LexObjective, number> = new Map(),
): {
  model: LPModel;
  recipeIndexMap: Map<string, RecipeId>;
  disposalDeficitSlackVarMap: Map<string, ItemId>;
  disposalSurplusSlackVarMap: Map<string, ItemId>;
  rawCapSlackVarMap: Map<string, ItemId>;
} => {
  // Stable variable names: x_<index>; map back to RecipeId via the index map.
  // Raw materials are excluded from balance constraints — their consumption
  // only contributes to the rawCost objective (infinite supply assumption).
  const itemConstraintNames = new Map<ItemId, string>();
  let i = 0;
  for (const itemId of input.itemConstraints.keys()) {
    if (input.rawMaterials.has(itemId)) continue;
    itemConstraintNames.set(itemId, `c_${i++}_${itemId}`);
  }

  const constraints: LPModel["constraints"] = {};
  for (const [itemId, c] of input.itemConstraints.entries()) {
    const name = itemConstraintNames.get(itemId);
    if (!name) continue;
    if (c.type === "equal") {
      constraints[name] = { equal: c.rhs };
    } else if (c.type === "disposal-slack") {
      // Strict balance via equality:
      //   prod - cons + slack_def - slack_sur = rhs
      // Both slacks added below as separate variables.
      constraints[name] = { equal: c.rhs };
    } else {
      // `min`: lower-bound constraint, surplus permitted.
      //   prod - cons ≥ rhs
      constraints[name] = { min: c.rhs };
    }
  }

  const variables: LPModel["variables"] = {};
  const recipeIndexMap = new Map<string, RecipeId>();
  input.recipes.forEach((recipe, idx) => {
    const varName = `x_${idx}`;
    variables[varName] = buildVariableCoefficients(
      recipe,
      itemConstraintNames,
      input.rawMaterials,
      input.costlessRaws,
      input.facilityMap,
    );
    recipeIndexMap.set(varName, recipe.id);
  });

  // Add two-sided disposal slack variables. The constraint above is
  //   prod - cons + slack_def - slack_sur = rhs
  // so the deficit slack has coef +1 and surplus slack has coef -1.
  // Both are penalised in every lex objective at `SLACK_PENALTY` (see
  // the constant above for rationale) so the LP only uses them when no
  // recipe combination can satisfy the constraint.
  //
  // Slack values never show up in user-facing totals: `extractSolution`
  // iterates recipe vars only (slack vars are kept separate in
  // `disposalDeficitSlackVarMap` / `disposalSurplusSlackVarMap` and
  // reported as deficits / surpluses respectively).
  const disposalDeficitSlackVarMap = new Map<string, ItemId>();
  const disposalSurplusSlackVarMap = new Map<string, ItemId>();
  let slackIdx = 0;
  for (const [itemId, c] of input.itemConstraints.entries()) {
    if (c.type !== "disposal-slack") continue;
    const constraintName = itemConstraintNames.get(itemId);
    if (!constraintName) continue;
    const idx = slackIdx++;
    const defName = `slack_def_${idx}_${itemId}`;
    const surName = `slack_sur_${idx}_${itemId}`;
    disposalDeficitSlackVarMap.set(defName, itemId);
    disposalSurplusSlackVarMap.set(surName, itemId);
    variables[defName] = {
      [constraintName]: 1,
      rawCost: SLACK_PENALTY,
      buildingCount: SLACK_PENALTY,
      power: SLACK_PENALTY,
    };
    variables[surName] = {
      [constraintName]: -1,
      rawCost: SLACK_PENALTY,
      buildingCount: SLACK_PENALTY,
      power: SLACK_PENALTY,
    };
  }

  // Add raw-cap constraints + slack variables.
  //
  // For each (rawItem, cap) in `input.rawCaps`:
  //   constraint:  Σ (input_rate × x_recipe) - rawCapSlack ≤ cap
  //   slack ≥ 0, penalized in every lex objective by SLACK_PENALTY
  //
  // Net behavior: the LP biases toward recipes that conserve the capped
  // raw (any recipe choice that exceeds the cap forces non-zero slack,
  // which the SLACK_PENALTY in every lex objective discourages); only
  // when no recipe combination fits does slack engage, absorbing the
  // overage. The slack value is reported per-item as `rawCapOveruse`
  // in the LPSolution and surfaced (in the calc layer) as warnings.
  //
  // **Variable namespace**: `rawcap_slack_*` is distinct from the
  // `slack_*` namespace used by disposal-slack. The two slack systems
  // coexist without interference.
  const rawCapSlackVarMap = new Map<string, ItemId>();
  if (input.rawCaps && input.rawCaps.size > 0) {
    // Phase 1: build constraint + slack-var entries for each valid cap.
    // Keep `itemId → constraintName` index so the recipe-walk below
    // can locate the right constraint by item id in O(1).
    const capConstraintByItem = new Map<ItemId, string>();
    let capIdx = 0;
    for (const [itemId, cap] of input.rawCaps) {
      // Defensive: skip invalid caps (the App-layer aggregation
      // already filters these, but the LP itself shouldn't crash on
      // a bad input).
      if (!Number.isFinite(cap) || cap < 0) continue;
      const constraintName = `rawcap_${capIdx}_${itemId}`;
      const slackName = `rawcap_slack_${capIdx}_${itemId}`;
      capIdx++;
      // Constraint: Σ (input_rate × x_recipe) − slack ≤ cap
      // The recipe coefficients are added in Phase 2 below; the slack
      // variable's −1 coefficient is set here.
      constraints[constraintName] = { max: cap };
      capConstraintByItem.set(itemId, constraintName);
      rawCapSlackVarMap.set(slackName, itemId);
      variables[slackName] = {
        [constraintName]: -1,
        rawCost: SLACK_PENALTY,
        buildingCount: SLACK_PENALTY,
        power: SLACK_PENALTY,
      };
    }

    // Phase 2: walk each recipe exactly once; for each input, look up
    // the matching cap constraint and append the per-facility
    // consumption rate to that recipe variable's coefficient column.
    //
    // Complexity: O(R × I) where R = recipes, I = avg inputs/recipe.
    // The previous nested form was O(C × R²) due to a `recipes.find`
    // inside the cap loop. With ~150 active recipes and ~6 caps the
    // old form did ~135k operations per pass × 3 lex passes; the
    // new form is ~3k × 3 = 9k.
    if (capConstraintByItem.size > 0) {
      input.recipes.forEach((recipe, idx) => {
        const varName = `x_${idx}`;
        for (const inp of recipe.inputs) {
          const constraintName = capConstraintByItem.get(inp.itemId);
          if (!constraintName) continue;
          const consumption = calcRate(inp.amount, recipe.craftingTime);
          // A recipe could in principle list the same input twice
          // (the input shape allows duplicates). Sum contributions.
          variables[varName][constraintName] =
            (variables[varName][constraintName] ?? 0) + consumption;
        }
      });
    }
  }

  // Per-facility caps (SOFT, slack-based).
  //
  // For each (facilityId, cap), constrain:
  //   Σ_{r : r.facilityId === facilityId} x_r − slack ≤ cap,  slack ≥ 0
  // with `slack` penalized by SLACK_PENALTY in every lex objective.
  //
  // The penalty dominates real per-recipe cost by 3-5 orders of
  // magnitude, so the LP strictly prefers cap-respecting solutions
  // whenever an alternative producer exists (a capped Sewage Inlet's
  // overflow routes to the uncapped Liquid Cleaner — Cleaner cost ≪
  // slack penalty). When NO alternative exists, slack engages and
  // the LP returns a feasible (over-cap) plan; the packer's existing
  // retry-without-caps path takes over and `computeOverCapWarnings`
  // surfaces the `facility-over-cap` warning at the hook layer.
  //
  // **Why not hard**: a hard cap returns LP-infeasible whenever
  // target demand exceeds `cap × throughput` and no alternative
  // producer is available. See the JSDoc on `LPInput.facilityCaps`
  // above for the xiranite_oven_1 user-reported regression that
  // motivated this design.
  //
  // Mirrors the `rawCaps` slack pattern above (separate variable
  // namespace; same exclusion from lex caps below).
  //
  // Only emit a constraint when at least one recipe in the current LP
  // actually uses the capped facility — defensive against caps for
  // facilities not present in the plan (e.g. LIQUID_CLEAN_GATE_1
  // capped to 3 when the user has no sewage-producing recipes active).
  const facilityCapSlackVarMap = new Map<string, FacilityId>();
  if (input.facilityCaps && input.facilityCaps.size > 0) {
    const recipeIdxsByFacility = new Map<FacilityId, number[]>();
    input.recipes.forEach((recipe, idx) => {
      const bucket = recipeIdxsByFacility.get(recipe.facilityId);
      if (bucket) bucket.push(idx);
      else recipeIdxsByFacility.set(recipe.facilityId, [idx]);
    });
    let facCapIdx = 0;
    for (const [facilityId, cap] of input.facilityCaps) {
      if (!Number.isFinite(cap) || cap < 0) continue;
      const idxs = recipeIdxsByFacility.get(facilityId);
      if (!idxs || idxs.length === 0) continue;
      const constraintName = `faccap_${facCapIdx}_${facilityId}`;
      const slackName = `faccap_slack_${facCapIdx}_${facilityId}`;
      facCapIdx++;
      constraints[constraintName] = { max: cap };
      for (const idx of idxs) {
        const varName = `x_${idx}`;
        variables[varName][constraintName] = 1;
      }
      variables[slackName] = {
        [constraintName]: -1,
        rawCost: SLACK_PENALTY,
        buildingCount: SLACK_PENALTY,
        power: SLACK_PENALTY,
      };
      facilityCapSlackVarMap.set(slackName, facilityId);
    }
  }

  // Lex caps: every previously-optimised objective gets an upper-bound
  // constraint here, so the current pass cannot regress on prior wins.
  // ALL slack vars (disposal-slack, rawcap-slack, facility-cap-slack)
  // are EXCLUDED from cap coefficients — they carry SLACK_PENALTY in
  // `rawCost` / `buildingCount` / `power` but `previousCaps[obj]` is
  // recipe-only (slack penalty isn't summed into a pass's reported
  // total). Including slack would force caps to ~tolerance and block
  // feasibility whenever an earlier pass had slack > 0. Slack is
  // independently minimised via SLACK_PENALTY in each pass's own
  // objective.
  for (const [capObj, capValue] of previousCaps.entries()) {
    const capName = `lex_cap_${capObj}`;
    constraints[capName] = { max: capValue + LEX_TOLERANCE[capObj] };
    for (const [varName, coefs] of Object.entries(variables)) {
      if (disposalDeficitSlackVarMap.has(varName)) continue;
      if (disposalSurplusSlackVarMap.has(varName)) continue;
      if (rawCapSlackVarMap.has(varName)) continue;
      if (facilityCapSlackVarMap.has(varName)) continue;
      coefs[capName] = coefs[capObj] ?? 0;
    }
  }

  return {
    model: {
      optimize: objective,
      opType: "min",
      constraints,
      variables,
    },
    recipeIndexMap,
    disposalDeficitSlackVarMap,
    disposalSurplusSlackVarMap,
    rawCapSlackVarMap,
  };
};

type ExtractedSolution = {
  facilityCounts: Map<RecipeId, number>;
  disposalDeficits: Map<ItemId, number>;
  disposalSurpluses: Map<ItemId, number>;
  rawCapOveruse: Map<ItemId, number>;
  totalRaw: number;
  totalBuildings: number;
  totalPower: number;
};

const extractSolution = (
  rawResult: Record<string, number | boolean | undefined>,
  recipeIndexMap: Map<string, RecipeId>,
  disposalDeficitSlackVarMap: Map<string, ItemId>,
  disposalSurplusSlackVarMap: Map<string, ItemId>,
  rawCapSlackVarMap: Map<string, ItemId>,
  recipes: Recipe[],
  facilityMap: Map<FacilityId, Facility>,
  rawMaterials: Set<ItemId>,
  costlessRaws: ReadonlySet<ItemId>,
): ExtractedSolution => {
  // Build O(1) RecipeId → Recipe lookup once instead of `recipes.find`
  // per variable.
  const recipesById = new Map<RecipeId, Recipe>();
  for (const r of recipes) recipesById.set(r.id, r);

  const facilityCounts = new Map<RecipeId, number>();
  let totalRaw = 0;
  let totalBuildings = 0;
  let totalPower = 0;
  for (const [varName, recipeId] of recipeIndexMap.entries()) {
    const v = rawResult[varName];
    const fc =
      typeof v === "number" && Math.abs(v) > FACILITY_COUNT_EPSILON ? v : 0;
    facilityCounts.set(recipeId, fc);
    const recipe = recipesById.get(recipeId)!;
    totalRaw += rawCostPerFacility(recipe, rawMaterials, costlessRaws) * fc;
    totalBuildings += fc;
    const facility = facilityMap.get(recipe.facilityId);
    totalPower += (facility?.powerConsumption ?? 0) * fc;
  }

  const disposalDeficits = new Map<ItemId, number>();
  for (const [varName, itemId] of disposalDeficitSlackVarMap.entries()) {
    const v = rawResult[varName];
    if (typeof v === "number" && v > LP_EPSILON) {
      disposalDeficits.set(itemId, v);
    }
  }
  const disposalSurpluses = new Map<ItemId, number>();
  for (const [varName, itemId] of disposalSurplusSlackVarMap.entries()) {
    const v = rawResult[varName];
    if (typeof v === "number" && v > LP_EPSILON) {
      disposalSurpluses.set(itemId, v);
    }
  }

  // Raw-cap slack values → per-item overage. Only entries above the
  // numerical epsilon are reported (rules out float drift near zero).
  const rawCapOveruse = new Map<ItemId, number>();
  for (const [varName, itemId] of rawCapSlackVarMap.entries()) {
    const v = rawResult[varName];
    if (typeof v === "number" && v > LP_EPSILON) {
      rawCapOveruse.set(itemId, v);
    }
  }

  return {
    facilityCounts,
    disposalDeficits,
    disposalSurpluses,
    rawCapOveruse,
    totalRaw,
    totalBuildings,
    totalPower,
  };
};

/** Map a `LexObjective` to its corresponding total in an extracted solution. */
const extractObjectiveTotal = (
  sol: ExtractedSolution,
  obj: LexObjective,
): number => {
  switch (obj) {
    case "rawCost":
      return sol.totalRaw;
    case "buildingCount":
      return sol.totalBuildings;
    case "power":
      return sol.totalPower;
  }
};

const finaliseSolution = (sol: ExtractedSolution): LPSolution => ({
  feasible: true,
  facilityCounts: sol.facilityCounts,
  disposalDeficits: sol.disposalDeficits,
  disposalSurpluses: sol.disposalSurpluses,
  rawCapOveruse: sol.rawCapOveruse,
  totalRawCost: sol.totalRaw,
  totalBuildingCount: sol.totalBuildings,
  totalPower: sol.totalPower,
});

/**
 * Solve a linear program with **lexicographic multi-pass objective**.
 *
 * Each pass `i` minimises `LEX_ORDER[i]` subject to upper-bound caps
 * `Σ coefs[LEX_ORDER[j]] × x ≤ optimum_j + tolerance` for every `j < i`.
 * The final pass's solution is therefore lex-optimal under `LEX_ORDER`.
 *
 * Current order: `rawCost → buildingCount → power`. `buildingCount` was
 * added to satisfy the user's "fewer buildings beats more buildings even
 * at equal raw cost" preference, ahead of `power` (which is the
 * tie-breaker for plans where building count also ties).
 *
 * Returns one of:
 *   - `{ feasible: true, facilityCounts, disposalDeficits, totalRawCost,
 *      totalBuildingCount, totalPower }` on success.
 *   - `{ feasible: false, reason }` on infeasibility, unbounded objective,
 *      or solver-library error at the first pass.
 *
 * **Fallback policy**: if any pass after the first fails (solver error,
 * infeasibility after lex-cap, or unboundedness), the previously-completed
 * pass's solution is returned. This keeps the LP robust against numerical
 * edge cases where a tight lex cap blocks feasibility — the prior pass's
 * solution still satisfies all original constraints, just not the latest
 * lex preference.
 */
export const solveLP = async (input: LPInput): Promise<LPResult> => {
  if (input.recipes.length === 0) {
    return {
      feasible: true,
      facilityCounts: new Map(),
      disposalDeficits: new Map(),
      disposalSurpluses: new Map(),
      rawCapOveruse: new Map(),
      totalRawCost: 0,
      totalBuildingCount: 0,
      totalPower: 0,
    };
  }

  const caps = new Map<LexObjective, number>();
  let lastSolution: ExtractedSolution | null = null;

  for (let passIdx = 0; passIdx < LEX_ORDER.length; passIdx++) {
    const objective = LEX_ORDER[passIdx];
    const {
      model,
      recipeIndexMap,
      disposalDeficitSlackVarMap,
      disposalSurplusSlackVarMap,
      rawCapSlackVarMap,
    } = buildModel(input, objective, caps);

    let result: Record<string, number | boolean | undefined>;
    try {
      result = await highsSolve(model);
    } catch (e) {
      if (import.meta.env?.DEV) {
        console.warn(
          `[LP_SOLVER] pass-${passIdx + 1} (${objective}) solver threw:`,
          e,
        );
      }
      if (lastSolution) return finaliseSolution(lastSolution);
      return { feasible: false, reason: "solver_error" };
    }

    if (result.feasible !== true) {
      if (lastSolution) {
        if (import.meta.env?.DEV) {
          console.warn(
            `[LP_SOLVER] pass-${passIdx + 1} (${objective}) infeasible after lex caps; falling back to pass-${passIdx}`,
          );
        }
        return finaliseSolution(lastSolution);
      }
      return { feasible: false, reason: "infeasible" };
    }
    if (result.bounded === false) {
      if (lastSolution) {
        if (import.meta.env?.DEV) {
          console.warn(
            `[LP_SOLVER] pass-${passIdx + 1} (${objective}) unbounded after lex caps; falling back to pass-${passIdx}`,
          );
        }
        return finaliseSolution(lastSolution);
      }
      return { feasible: false, reason: "unbounded" };
    }

    lastSolution = extractSolution(
      result,
      recipeIndexMap,
      disposalDeficitSlackVarMap,
      disposalSurplusSlackVarMap,
      rawCapSlackVarMap,
      input.recipes,
      input.facilityMap,
      input.rawMaterials,
      input.costlessRaws,
    );
    caps.set(objective, extractObjectiveTotal(lastSolution, objective));
  }

  // lastSolution is guaranteed non-null: LEX_ORDER has ≥ 1 entry, so the
  // loop ran at least once and either populated lastSolution or returned
  // early on infeasibility.
  return finaliseSolution(lastSolution!);
};

