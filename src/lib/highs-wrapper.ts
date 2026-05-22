/**
 * Thin translation layer between the jsLPSolver-style `Model` shape
 * used throughout this codebase and HiGHS's CPLEX LP file format.
 *
 * Why this layer exists: the legacy `javascript-lp-solver` accepts a
 * JSON object describing variables, constraints, and an objective.
 * HiGHS (via `@bubblyworld/highs-ts`) accepts a CPLEX `.lp` format
 * STRING (or MPS, or the Model builder API). Rather than rewrite every
 * call site to build LP strings or builder calls directly, we keep
 * the existing Model shape and translate on the way in/out.
 *
 * Format reference:
 * - https://web.mit.edu/lpsolve/doc/CPLEX-format.htm
 * - HiGHS docs: https://ergo-code.github.io/HiGHS/dev/options/definitions/
 *
 * Behavioural parity with jsLPSolver:
 * - Variables default to non-negative continuous (HiGHS's default too).
 * - `ints: { x: 1 }` becomes an `Integer` section listing `x`.
 * - `constraints` with `min: N`, `max: N`, `equal: N` map to
 *   `>= N`, `<= N`, `= N` respectively. `{ min, max }` (range) splits
 *   into two constraints because the LP format's range syntax is
 *   inconsistent across solver builds and we'd rather be explicit.
 * - Objective key (e.g. `optimize: "rawCost"`) names the row in the
 *   `Minimize` / `Maximize` section. Variable coefficients on that
 *   key form the objective expression.
 *
 * Result shape: returns a plain `Record<varName, number>` augmented
 * with `feasible: boolean`, `bounded: boolean`, and `result: number`
 * — matching the legacy jsLPSolver output so call sites don't need
 * to know which solver produced it.
 *
 * The wrapper is async because `@bubblyworld/highs-ts`'s `parse()`
 * and `solve()` return Promises. Call sites awaiting `solve()` need
 * to be async themselves; see `lp-solver.ts` and
 * `multi-formula-packing.ts` for the cascade.
 */
import { getHighs } from "./highs-singleton";

/** Solver-input model — shape matches jsLPSolver's `Model`. */
export type LPModel = {
  optimize: string;
  opType: "min" | "max";
  constraints: Record<
    string,
    { min?: number; max?: number; equal?: number }
  >;
  variables: Record<string, Record<string, number>>;
  ints?: Record<string, 1 | true>;
  /** Optional solver runtime cap in seconds (HiGHS-native `time_limit`). */
  options?: { timeLimitSeconds?: number };
};

/**
 * jsLPSolver-shape result — used by all our solver call sites today.
 * `result` is the objective value at the optimum; per-variable values
 * appear as top-level keys (`{ feasible: true, x: 3, y: 5, ... }`).
 */
export type LPResult = Record<string, number | boolean | undefined> & {
  feasible: boolean;
  /**
   * `true` if the problem has a bounded optimum, `false` if unbounded.
   * jsLPSolver convention: omitted-or-true means bounded; false means
   * unbounded. We preserve this so call sites can rely on
   * `r.bounded === false` as the unbounded signal.
   */
  bounded?: boolean;
  result?: number;
};

/**
 * Solve an LP model via HiGHS. Async — `@bubblyworld/highs-ts`'s
 * `parse()` and `solve()` return Promises. Throws if `initHighs()`
 * hasn't been awaited yet (defensive guard from the singleton).
 *
 * Returns a jsLPSolver-compatible result object — see `LPResult`.
 *
 * The translation is deterministic: same input always produces
 * structurally-identical LP file, so HiGHS picks the same solution
 * across runs (modulo HiGHS's internal nondeterminism, controlled by
 * the `random_seed: 0` default).
 *
 * NOT concurrent-safe: relies on sequential callers. The shared
 * HiGHS instance is mutated by `setParam` and `parse`, and the
 * subsequent `solve` reads that state. Current callers are all
 * `await`-chained (sequential). If concurrent solves ever become
 * necessary (e.g., a vitest test marked `test.concurrent`), add
 * an internal mutex or switch to instance-per-call (with `free()`
 * afterwards).
 */
export async function solve(model: LPModel): Promise<LPResult> {
  const lpFile = buildLpFileString(model);
  // Sentinel emitted by `buildLpFileString` when a constraint with
  // no variable terms cannot be satisfied (e.g. `0 = 30`). HiGHS
  // can't see the original constraint, so we'd otherwise get a
  // spurious-feasible solution at all-zeros. Bail with infeasible.
  if (lpFile.includes("__STRUCTURALLY_INFEASIBLE__")) {
    return { feasible: false };
  }
  const highs = getHighs();
  // Tighter feasibility tolerances than HiGHS's defaults (1e-7) so
  // returned variable values clear our LP_EPSILON = 1e-9 check
  // downstream. `1e-10` is the HiGHS option schema's lower bound.
  highs.setParam("primal_feasibility_tolerance", 1e-10);
  highs.setParam("dual_feasibility_tolerance", 1e-10);
  // Optional per-call runtime cap.
  if (model.options?.timeLimitSeconds !== undefined) {
    highs.setParam("time_limit", model.options.timeLimitSeconds);
  }
  // Each parse() replaces the previously-loaded model on the shared instance.
  await highs.parse(lpFile, "lp");
  const solution = await highs.solve();
  return parseHighsSolution(solution);
}

/**
 * Build a CPLEX `.lp` format string from a jsLPSolver-shape model.
 *
 * Identifier safety: variable and constraint names are emitted as-is.
 * Our call sites use ASCII identifiers (`x_0`, `c_3_item_foo`,
 * `cls_5_total`, etc.) which are all valid CPLEX names. If we ever
 * pass non-ASCII or whitespace-containing names, this needs an
 * escape pass — but today's call sites don't.
 */
function buildLpFileString(model: LPModel): string {
  const lines: string[] = [];

  // === Objective ===
  lines.push(model.opType === "max" ? "Maximize" : "Minimize");
  const objKey = model.optimize;
  const objTerms = collectVariableCoefficients(model.variables, objKey);
  lines.push(` obj: ${formatExpression(objTerms)}`);
  lines.push("");

  // === Constraints ===
  // CPLEX LP format requires at least one term per constraint. For
  // zero-coefficient rows we drop the constraint, but if the bound
  // is non-satisfiable (e.g. `0 = 30`, which can arise from SCC
  // cycle cancellation collapsing `prod − cons = demand` to
  // `0 = demand`), we flag a sentinel below that `solve()` maps to
  // `{ feasible: false }`.
  let structurallyInfeasible = false;
  lines.push("Subject To");
  for (const [cName, bounds] of Object.entries(model.constraints)) {
    const terms = collectVariableCoefficients(model.variables, cName);
    if (terms.length === 0) {
      // Zero-coefficient constraint: check whether the implicit
      // constant `0` satisfies the bound. If not, the LP is
      // structurally infeasible.
      if (bounds.equal !== undefined && bounds.equal !== 0) {
        structurallyInfeasible = true;
      }
      if (bounds.min !== undefined && bounds.min > 0) {
        structurallyInfeasible = true;
      }
      if (bounds.max !== undefined && bounds.max < 0) {
        structurallyInfeasible = true;
      }
      continue;
    }
    const expr = formatExpression(terms);

    // jsLPSolver allows a single constraint object to carry multiple
    // bound kinds (e.g. `{ min: 0, max: 10 }`). CPLEX LP supports
    // ranged constraints but the syntax varies across solver builds;
    // we emit two separate inequalities for unambiguous parsing.
    if (bounds.equal !== undefined) {
      lines.push(` ${cName}: ${expr} = ${formatNumber(bounds.equal)}`);
    } else {
      if (bounds.min !== undefined) {
        lines.push(` ${cName}_min: ${expr} >= ${formatNumber(bounds.min)}`);
      }
      if (bounds.max !== undefined) {
        lines.push(` ${cName}_max: ${expr} <= ${formatNumber(bounds.max)}`);
      }
    }
  }
  lines.push("");
  if (structurallyInfeasible) {
    // Surface via a sentinel that `solve()` translates to
    // `feasible: false`. We can't tell HiGHS "this is infeasible"
    // through the LP file (it'd just try and succeed with x=0).
    // Caller's `if (!result.feasible)` branches already handle this.
    lines.push("__STRUCTURALLY_INFEASIBLE__");
  }

  // === Bounds ===
  // HiGHS / CPLEX LP defaults: variables are >= 0 and unbounded above.
  // That's what our call sites assume, so we don't need an explicit
  // Bounds section unless we want to override. Skipping keeps the LP
  // file small and reduces parser surface area.

  // === Integer ===
  if (model.ints && Object.keys(model.ints).length > 0) {
    lines.push("Integer");
    for (const varName of Object.keys(model.ints)) {
      lines.push(` ${varName}`);
    }
    lines.push("");
  }

  lines.push("End");
  return lines.join("\n");
}

/**
 * Collect (varName, coefficient) pairs for one row of the model — the
 * coefficient each variable contributes to either the objective or one
 * named constraint.
 *
 * Returns only entries with non-zero coefficient (omitted zeros never
 * appear in the LP file).
 */
function collectVariableCoefficients(
  variables: Record<string, Record<string, number>>,
  rowName: string,
): Array<{ varName: string; coef: number }> {
  const out: Array<{ varName: string; coef: number }> = [];
  for (const [varName, coefMap] of Object.entries(variables)) {
    const c = coefMap[rowName];
    if (c === undefined || c === 0) continue;
    out.push({ varName, coef: c });
  }
  return out;
}

/**
 * Format a list of `(varName, coef)` pairs as a CPLEX expression:
 *   "2.5 x + y - 3 z"
 *
 * - Leading "+" is omitted ("2.5 x" not "+ 2.5 x").
 * - Coefficient 1 / -1 emits "x" / "- x" (no explicit "1 ").
 * - Subsequent terms emit "+ N x" / "- N x".
 * - Zero terms are skipped upstream.
 */
function formatExpression(
  terms: Array<{ varName: string; coef: number }>,
): string {
  if (terms.length === 0) return "0";
  const parts: string[] = [];
  for (let i = 0; i < terms.length; i++) {
    const { varName, coef } = terms[i];
    const isFirst = i === 0;
    const sign = coef >= 0 ? "+" : "-";
    const absCoef = Math.abs(coef);
    const coefStr = absCoef === 1 ? "" : `${formatNumber(absCoef)} `;
    if (isFirst) {
      // First term: only prepend "-" if negative.
      parts.push(coef >= 0 ? `${coefStr}${varName}` : `- ${coefStr}${varName}`);
    } else {
      parts.push(`${sign} ${coefStr}${varName}`);
    }
  }
  return parts.join(" ");
}

/**
 * Number formatting that preserves precision without scientific
 * notation in the LP file (some LP parsers are finicky about `1e-9`).
 * Uses `Number.toString()` which gives ~17 significant digits when
 * needed and short integer / decimal output for round values.
 */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`[HIGHS_WRAPPER] non-finite coefficient: ${n}`);
  }
  return n.toString();
}

/**
 * Convert `@bubblyworld/highs-ts`'s structured `Solution` object back
 * to the jsLPSolver-shape `LPResult` our call sites expect.
 *
 * Status mapping:
 *   - "optimal" → feasible=true, bounded=true.
 *   - "unbounded" → feasible=true, bounded=false.
 *   - "infeasible" / others → feasible=false.
 *
 * Variable values come from `solution.solution.get(name)`. Variables
 * the solver didn't include (zero values may be omitted) are returned
 * as 0 — but in practice `@bubblyworld/highs-ts` returns every
 * variable in the map, including explicit zeros.
 */
/** Subset of `@bubblyworld/highs-ts`'s `SolveResult` we read. */
type BubblySolution = {
  status: string;
  objective?: number;
  solution?: Map<string, number>;
};

function parseHighsSolution(solution: BubblySolution): LPResult {
  const result: LPResult = { feasible: false };

  switch (solution.status) {
    case "optimal":
      result.feasible = true;
      result.bounded = true;
      break;
    case "unbounded":
      result.feasible = true;
      result.bounded = false;
      break;
    case "infeasible":
    case "unboundedorinfeasible":
    default:
      // timelimit / iterationlimit / solutionlimit / objectivebound /
      // objectivetarget / error / unknown statuses fall here. Treat
      // as infeasible for call-site simplicity; the existing fallback
      // chains (Pass 2 → Pass 1 → singletons) handle this case.
      result.feasible = false;
      break;
  }

  if (result.feasible && solution.solution) {
    result.result = solution.objective;
    for (const [varName, value] of solution.solution.entries()) {
      if (typeof value === "number" && Number.isFinite(value)) {
        result[varName] = value;
      }
    }
  }

  return result;
}
