/**
 * LP-based SCC flow solver.
 *
 * Uses `javascript-lp-solver` to formulate each SCC sub-problem as a linear
 * program with:
 *   - Variables: facility count per recipe (continuous, ≥ 0).
 *   - Constraints per item, with the operator selected by the caller via
 *     `LPItemConstraint.type`:
 *       - `equal` — strict mass balance (`prod - cons = rhs`).
 *       - `min` — lower bound (`prod - cons ≥ rhs`); allows surplus.
 *       - `disposal-slack` — `prod - cons + slack ≥ rhs` with slack ≥ 0
 *         and a high cost; allows surplus and lets `slack` absorb deficit
 *         that the caller will propagate to upstream producers.
 *   - Raw materials (items in `LPInput.rawMaterials`) are skipped from
 *     constraints — the LP doesn't enforce balance, only counts their
 *     consumption in the `rawCost` objective (infinite-supply assumption).
 *   - Lexicographic two-pass objective: minimize raw-material consumption
 *     first, then minimize total power among solutions tying for raw-min.
 *
 * Per-recipe raw cost is computed from direct raw-material inputs only
 * (transitive raw-cost-through-intermediates is intentionally not modelled
 * here; per-SCC LPs minimize their local contribution and the global plan's
 * raw cost emerges from each SCC + linear-DAG layer choosing minimal
 * recipes).
 */

import solver from "javascript-lp-solver";
import { calcRate } from "@/lib/utils";
import type { ItemId, RecipeId, FacilityId, Recipe, Facility } from "@/types";

/** Numerical tolerance used for sign / equality checks against LP output. */
const LP_EPSILON = 1e-9;

/** Tiny buffer added to the raw-cost upper-bound between the two LP passes
 *  to absorb library-level floating-point noise. */
const LEX_RAW_TOLERANCE = 1e-6;

/**
 * Cost coefficient on disposal-slack variables in both `rawCost` and
 * `power` objectives. Chosen large enough that LP strictly prefers
 * solutions with slack = 0; deficits in the result therefore reflect "no
 * internal solution exists" rather than "LP took the lazy path". 1e6 is
 * far above any conceivable per-facility cost in the current data set.
 */
const SLACK_PENALTY = 1e6;

/**
 * Tiny positive baseline added to each recipe's `power` cost so zero-power
 * recipes (or recipes whose facility lookup fails) remain bounded under
 * the power-minimization pass. Without this, LP could run such recipes
 * arbitrarily high without paying anything in pass 2.
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
  /** Recipes participating in the LP (typically an SCC's recipes). */
  recipes: Recipe[];
  /**
   * Constraints per item. The full set of items mentioned by any recipe's
   * inputs/outputs MUST appear here, otherwise the LP under-constrains the
   * solution. Items not relevant to the SCC's local balance can use
   * `{ type: "min", rhs: 0 }`.
   */
  itemConstraints: Map<ItemId, LPItemConstraint>;
  /**
   * Recipes whose facility count is fixed (typically because the user
   * overrode the producer for some item, and we want LP to honor that
   * choice). The LP adds an equality constraint `x[recipe] = count`.
   *
   * Used by `tryExtendSCCWithFeeders` to force user-overridden recipes
   * to actually run when a feeder is added.
   */
  pinnedRecipes?: Map<RecipeId, number>;
  /** Items that should contribute to the raw-cost objective. */
  rawMaterials: Set<ItemId>;
  /** Facility lookup for power-cost computation. */
  facilityMap: Map<FacilityId, Facility>;
};

export type LPSolution = {
  feasible: true;
  facilityCounts: Map<RecipeId, number>;
  /** Per-item deficit to propagate to upstream producers (only populated for items with `type: "disposal-slack"` in the input). */
  disposalDeficits: Map<ItemId, number>;
  totalRawCost: number;
  totalPower: number;
};

export type LPFailure = {
  feasible: false;
  reason: "infeasible" | "unbounded" | "solver_error";
};

export type LPResult = LPSolution | LPFailure;

/**
 * Compute the per-facility-per-minute raw-material consumption rate for
 * a recipe. Counts only inputs in the supplied raw-materials set.
 */
const rawCostPerFacility = (
  recipe: Recipe,
  rawMaterials: Set<ItemId>,
): number => {
  let cost = 0;
  for (const input of recipe.inputs) {
    if (rawMaterials.has(input.itemId)) {
      cost += calcRate(input.amount, recipe.craftingTime);
    }
  }
  return cost;
};

/**
 * Build the variable-coefficient block for one recipe in the LP model.
 * Coefficients map each constraint name to the recipe's net rate for the
 * corresponding item. The objective coefficients (`raw`, `power`) are also
 * attached.
 */
const buildVariableCoefficients = (
  recipe: Recipe,
  itemConstraintNames: Map<ItemId, string>,
  rawMaterials: Set<ItemId>,
  facilityMap: Map<FacilityId, Facility>,
): Record<string, number> => {
  const coefs: Record<string, number> = {};

  // Net rate per facility per minute for each item this recipe touches.
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

  // Objective coefficients.
  coefs.rawCost = rawCostPerFacility(recipe, rawMaterials);
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
  objective: "rawCost" | "power",
  fixedRawCostUpperBound?: number,
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
  // Reverse lookup: RecipeId → varName. Used by `pinnedRecipes` injection
  // and by `extractSolution` to avoid O(n²) `recipes.find` scans.
  const varNameByRecipeId = new Map<RecipeId, string>();
  input.recipes.forEach((recipe, idx) => {
    const varName = `x_${idx}`;
    variables[varName] = buildVariableCoefficients(
      recipe,
      itemConstraintNames,
      input.rawMaterials,
      input.facilityMap,
    );
    recipeIndexMap.set(varName, recipe.id);
    varNameByRecipeId.set(recipe.id, varName);
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
      rawCost: SLACK_PENALTY,
      power: SLACK_PENALTY,
    };
  }

  // Pinned recipes get an equality constraint forcing their facility count
  // to the specified value. Used to honor user recipe-overrides during
  // feeder extension.
  if (input.pinnedRecipes) {
    let pinIdx = 0;
    for (const [recipeId, count] of input.pinnedRecipes.entries()) {
      const varName = varNameByRecipeId.get(recipeId);
      if (!varName) continue;
      const constraintName = `pin_${pinIdx++}_${recipeId}`;
      constraints[constraintName] = { equal: count };
      variables[varName][constraintName] = 1;
    }
  }

  // For lex pass 2: bound raw cost at the pass-1 optimum (with a tiny
  // floating-point tolerance) so power minimization respects it.
  //
  // Slack variables are EXCLUDED from this constraint. Slack vars carry
  // SLACK_PENALTY (1e6) in their `rawCost` field, but `fixedRawCostUpperBound`
  // (from pass 1's `extractSolution`) sums only `rawCostPerFacility × x[r]`
  // over recipes — slack penalty isn't included in that total. If we let
  // slack contribute to `lex_raw_cap`, the LHS would evaluate to
  // `recipe_raw + SLACK_PENALTY × slack` while the RHS is `recipe_raw +
  // tolerance`, making pass 2 infeasible whenever pass 1 had slack > 0.
  // Pass 2 would then fall back to pass 1's result, skipping power
  // minimization and violating the documented lex raw → power invariant.
  // Slack is independently minimized via SLACK_PENALTY in pass 2's power
  // objective, so it doesn't need an additional cap.
  if (objective === "power" && fixedRawCostUpperBound !== undefined) {
    constraints.lex_raw_cap = {
      max: fixedRawCostUpperBound + LEX_RAW_TOLERANCE,
    };
    for (const [varName, coefs] of Object.entries(variables)) {
      if (disposalSlackVarMap.has(varName)) continue;
      coefs.lex_raw_cap = coefs.rawCost;
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

const extractSolution = (
  rawResult: Record<string, number | boolean | undefined>,
  recipeIndexMap: Map<string, RecipeId>,
  disposalSlackVarMap: Map<string, ItemId>,
  recipes: Recipe[],
  facilityMap: Map<FacilityId, Facility>,
  rawMaterials: Set<ItemId>,
): {
  facilityCounts: Map<RecipeId, number>;
  disposalDeficits: Map<ItemId, number>;
  totalRaw: number;
  totalPower: number;
} => {
  // Build O(1) RecipeId → Recipe lookup once instead of `recipes.find`
  // per variable.
  const recipesById = new Map<RecipeId, Recipe>();
  for (const r of recipes) recipesById.set(r.id, r);

  const facilityCounts = new Map<RecipeId, number>();
  let totalRaw = 0;
  let totalPower = 0;
  for (const [varName, recipeId] of recipeIndexMap.entries()) {
    const v = rawResult[varName];
    const fc = typeof v === "number" && Math.abs(v) > LP_EPSILON ? v : 0;
    facilityCounts.set(recipeId, fc);
    const recipe = recipesById.get(recipeId)!;
    totalRaw += rawCostPerFacility(recipe, rawMaterials) * fc;
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

  return { facilityCounts, disposalDeficits, totalRaw, totalPower };
};

/**
 * Solve a linear program for an SCC sub-problem.
 *
 * Lexicographic two-pass:
 *   1. Minimize raw-material consumption.
 *   2. Subject to raw cost ≤ pass-1 optimum (plus a small numerical
 *      tolerance), minimize total power.
 *
 * Returns one of:
 *   - `{ feasible: true, facilityCounts, disposalDeficits, totalRawCost,
 *      totalPower }` on success. `disposalDeficits` is keyed by `ItemId`
 *      and contains values for items that hit slack (i.e., the SCC has a
 *      deficit on that disposal item that must be supplied upstream).
 *   - `{ feasible: false, reason }` on infeasibility, unbounded objective,
 *      or solver-library error. The infeasible case typically means the
 *      caller should fall through to feeder extension or accept the SCC
 *      as invalid.
 */
export const solveLP = (input: LPInput): LPResult => {
  if (input.recipes.length === 0) {
    return {
      feasible: true,
      facilityCounts: new Map(),
      disposalDeficits: new Map(),
      totalRawCost: 0,
      totalPower: 0,
    };
  }

  // Pass 1: raw-cost minimization.
  const { model: rawModel, recipeIndexMap, disposalSlackVarMap } =
    buildModel(input, "rawCost");
  let rawResult: Record<string, number | boolean | undefined>;
  try {
    rawResult = solver.Solve(rawModel) as Record<string, number | boolean | undefined>;
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.warn("[LP_SOLVER] pass-1 solver threw:", e);
    }
    return { feasible: false, reason: "solver_error" };
  }
  if (rawResult.feasible !== true) {
    return { feasible: false, reason: "infeasible" };
  }
  if (rawResult.bounded === false) {
    return { feasible: false, reason: "unbounded" };
  }
  const rawSolution = extractSolution(
    rawResult,
    recipeIndexMap,
    disposalSlackVarMap,
    input.recipes,
    input.facilityMap,
    input.rawMaterials,
  );

  // Pass 2: power minimization with raw-cost upper-bound constraint.
  const {
    model: powerModel,
    recipeIndexMap: powerIndexMap,
    disposalSlackVarMap: powerSlackMap,
  } = buildModel(input, "power", rawSolution.totalRaw);
  let powerResult: Record<string, number | boolean | undefined>;
  try {
    powerResult = solver.Solve(powerModel) as Record<string, number | boolean | undefined>;
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.warn("[LP_SOLVER] pass-2 solver threw, falling back to pass-1:", e);
    }
    // Library failure on pass 2: fall back to pass-1 result (raw-min is
    // still a valid feasible plan).
    return {
      feasible: true,
      facilityCounts: rawSolution.facilityCounts,
      disposalDeficits: rawSolution.disposalDeficits,
      totalRawCost: rawSolution.totalRaw,
      totalPower: rawSolution.totalPower,
    };
  }

  if (powerResult.feasible !== true || powerResult.bounded === false) {
    if (import.meta.env?.DEV) {
      console.warn(
        `[LP_SOLVER] pass-2 ${powerResult.bounded === false ? "unbounded" : "infeasible"} after lex-cap; falling back to pass-1`,
      );
    }
    // Numerical edge case: pass-1 was feasible but the lex-cap re-solve
    // isn't. Fall back to pass-1 plan; it still satisfies all original
    // constraints. The `bounded === false` arm is defensive: pass 2 is
    // currently bounded by structure (POWER_COST_FLOOR floor + lex_raw_cap
    // ceiling), but this protects against future changes that might
    // break the bounding invariant.
    return {
      feasible: true,
      facilityCounts: rawSolution.facilityCounts,
      disposalDeficits: rawSolution.disposalDeficits,
      totalRawCost: rawSolution.totalRaw,
      totalPower: rawSolution.totalPower,
    };
  }

  const powerSolution = extractSolution(
    powerResult,
    powerIndexMap,
    powerSlackMap,
    input.recipes,
    input.facilityMap,
    input.rawMaterials,
  );

  return {
    feasible: true,
    facilityCounts: powerSolution.facilityCounts,
    disposalDeficits: powerSolution.disposalDeficits,
    totalRawCost: powerSolution.totalRaw,
    totalPower: powerSolution.totalPower,
  };
};

