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
   * Forced-disposal slack: `production - consumption + slack ≥ rhs` with
   * `slack ≥ 0` and a high cost on slack so it's only used when no recipe
   * combination can satisfy the constraint. The slack value is reported in
   * the solution as a `disposalDeficit` and represents the deficit to be
   * supplied externally (e.g. upstream Hetonite chain providing Sewage
   * that the SCC's POOL consumer needs).
   *
   * Use for items in `forcedDisposalItems` where the SCC may have an
   * internal deficit that must be propagated to upstream recipes outside
   * the SCC.
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
  /** Facility lookup for power-cost computation. */
  facilityMap: Map<FacilityId, Facility>;
};

export type LPSolution = {
  feasible: true;
  facilityCounts: Map<RecipeId, number>;
  /** Per-item deficit to propagate to upstream producers (only populated for items with `type: "disposal-slack"` in the input). */
  disposalDeficits: Map<ItemId, number>;
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
  disposalSlackVarMap: Map<string, ItemId>;
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
    } else {
      // Both `min` and `disposal-slack` map to a `min: rhs` lower-bound
      // constraint. They differ in whether a slack variable contributes
      // to the LHS — added below in the slack-variables block. With slack:
      //   prod - cons + slack ≥ rhs    (surplus OK, slack absorbs deficit)
      // Without slack:
      //   prod - cons ≥ rhs            (surplus OK, deficit infeasible)
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

  // Add disposal-slack variables; see the `SLACK_PENALTY` constant above
  // for the cost rationale.
  const disposalSlackVarMap = new Map<string, ItemId>();
  let slackIdx = 0;
  for (const [itemId, c] of input.itemConstraints.entries()) {
    if (c.type !== "disposal-slack") continue;
    const constraintName = itemConstraintNames.get(itemId);
    if (!constraintName) continue;
    const slackName = `slack_${slackIdx++}_${itemId}`;
    disposalSlackVarMap.set(slackName, itemId);
    variables[slackName] = {
      [constraintName]: 1,
      // Slack must be penalised in EVERY lex objective so it's only used
      // when no recipe combination can satisfy the disposal constraint.
      // The penalty does NOT show up in user-facing totals because
      // `extractSolution` iterates recipe vars only (slack vars are kept
      // separate in `disposalSlackVarMap` and reported as deficits).
      rawCost: SLACK_PENALTY,
      buildingCount: SLACK_PENALTY,
      power: SLACK_PENALTY,
    };
  }

  // Lex caps: every previously-optimised objective gets an upper-bound
  // constraint here, so the current pass cannot regress on prior wins.
  // Slack vars are EXCLUDED from cap coefficients — they carry
  // SLACK_PENALTY in `rawCost` / `power` but `previousCaps[obj]` is
  // recipe-only (slack penalty isn't summed into a pass's reported total).
  // Including slack would force caps to ~tolerance and block feasibility
  // whenever an earlier pass had slack > 0. Slack is independently
  // minimised via SLACK_PENALTY in each pass's own objective.
  for (const [capObj, capValue] of previousCaps.entries()) {
    const capName = `lex_cap_${capObj}`;
    constraints[capName] = { max: capValue + LEX_TOLERANCE[capObj] };
    for (const [varName, coefs] of Object.entries(variables)) {
      if (disposalSlackVarMap.has(varName)) continue;
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
    disposalSlackVarMap,
  };
};

type ExtractedSolution = {
  facilityCounts: Map<RecipeId, number>;
  disposalDeficits: Map<ItemId, number>;
  totalRaw: number;
  totalBuildings: number;
  totalPower: number;
};

const extractSolution = (
  rawResult: Record<string, number | boolean | undefined>,
  recipeIndexMap: Map<string, RecipeId>,
  disposalSlackVarMap: Map<string, ItemId>,
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
  for (const [varName, itemId] of disposalSlackVarMap.entries()) {
    const v = rawResult[varName];
    if (typeof v === "number" && v > LP_EPSILON) {
      disposalDeficits.set(itemId, v);
    }
  }

  return { facilityCounts, disposalDeficits, totalRaw, totalBuildings, totalPower };
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
      totalRawCost: 0,
      totalBuildingCount: 0,
      totalPower: 0,
    };
  }

  const caps = new Map<LexObjective, number>();
  let lastSolution: ExtractedSolution | null = null;

  for (let passIdx = 0; passIdx < LEX_ORDER.length; passIdx++) {
    const objective = LEX_ORDER[passIdx];
    const { model, recipeIndexMap, disposalSlackVarMap } = buildModel(
      input,
      objective,
      caps,
    );

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
      disposalSlackVarMap,
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

