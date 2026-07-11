/**
 * Target optimizer — Max(X) / Fit-to-limits engine.
 *
 * Three layers, all pure (no React, no calc-client import — the solver
 * transport is injected so tests drive `calculateProductionPlan`
 * directly and the hook drives the worker client):
 *
 *   - `rawsInChainOf` — Max-button gating closure (Phase F).
 *   - `isPlanFeasible` — the shared feasibility predicate: facility
 *     caps on `physicalPerFacility` (the SAME aggregate the UI badges
 *     read), raw caps on the plan's raw-node requirements, and the
 *     `metastorage-budget-insufficient` warning scan.
 *   - `maximizeTargetRate` / `fitTargetsToLimits` — the bisection
 *     engines. Max is *priority-Max*: pass 1 maximizes X with unlocked
 *     others at 0 (locked frozen), pass 2 hands the leftovers back to
 *     the unlocked others via the Fit bisection.
 *
 * Invariants (full design + rationale in
 * `docs/plan-target-optimizer.md` — read it before editing):
 *
 *   - **Verified-feasible**: every returned rate was verified by an
 *     actual solve. Max bisects on the integer milli-rate grid
 *     (1 = 0.001/min) and returns `lo`, which only ever moves to a
 *     probed-feasible value; Fit tracks the best verified rounded
 *     vector. No trailing rounding step can produce an unverified
 *     value. This also defends against ILP-packing non-monotonicity.
 *   - **Errors propagate**: solve rejections are NOT caught here (a
 *     transient failure treated as "infeasible" would corrupt the
 *     bracket). The hook maps `CalcSupersededError` → silent abort,
 *     anything else → error toast.
 *   - **Cancellation**: `isCancelled` is checked before every solve;
 *     the engines return `{ kind: "cancelled" }`.
 */
import {
  aggregateBinTotals,
  computeOverCapWarnings,
  computeRawOverCapWarnings,
} from "@/lib/plan-helpers";
import type {
  Facility,
  FacilityId,
  Item,
  ItemId,
  ProductionDependencyGraph,
  Recipe,
} from "@/types";

/**
 * Backward closure over `recipes`: every item that can appear anywhere
 * in a production chain ending at `itemId`, intersected with
 * `rawMaterials`.
 *
 * Walks ALL alternative producers (mirroring `buildBipartiteGraph`'s
 * no-single-pick philosophy): if any available recipe chain can consume
 * a raw while producing `itemId`, that raw is in the result. This
 * deliberately over-approximates the raws the LP will actually pick —
 * for Max-button gating an over-approximation errs toward enabling the
 * button, and the engine's bracketing ceiling ("no limit reached")
 * defends against the false-positive case at runtime.
 *
 * Cycles (planter ↔ seed) are handled by the visited set; complexity is
 * O(items + recipe inputs) per call.
 */
export function rawsInChainOf(
  itemId: ItemId,
  recipes: readonly Recipe[],
  rawMaterials: ReadonlySet<ItemId>,
): Set<ItemId> {
  // Producer index: output item -> recipes that emit it.
  const producersByItem = new Map<ItemId, Recipe[]>();
  for (const recipe of recipes) {
    for (const output of recipe.outputs) {
      let list = producersByItem.get(output.itemId);
      if (!list) {
        list = [];
        producersByItem.set(output.itemId, list);
      }
      list.push(recipe);
    }
  }

  const raws = new Set<ItemId>();
  const visited = new Set<ItemId>();
  const queue: ItemId[] = [itemId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    // A raw terminates its branch: raws have no modeled producers, and
    // even if a recipe emitted one as a byproduct, the LP sources raws
    // from pickup points — the cap applies regardless.
    if (rawMaterials.has(current)) {
      raws.add(current);
      continue;
    }
    for (const recipe of producersByItem.get(current) ?? []) {
      for (const input of recipe.inputs) {
        if (!visited.has(input.itemId)) queue.push(input.itemId);
      }
    }
  }
  return raws;
}

/* ── Feasibility ──────────────────────────────────────────────────── */

/** One entry of a solve-vector: what the injected solver consumes. */
export type TargetVectorEntry = { itemId: ItemId; rate: number };

/** The slice of `ProductionTarget` the engine needs (UI type lives in
 *  `TargetItemsGrid.tsx`; keeping a structural type here avoids a
 *  lib → component import). */
export type OptimizableTarget = {
  itemId: ItemId;
  rate: number;
  locked?: boolean;
};

/**
 * Everything `isPlanFeasible` needs besides the plan. Mirrors the
 * hook's badge pipeline exactly — `facilityCaps` against
 * `physicalPerFacility`, `rawCaps` against the raw-node requirement
 * fold (which counts `manualRawMaterials` like
 * `useProductionStats.collectStats` does).
 */
export type FeasibilityContext = {
  facilities: Facility[];
  items: Item[];
  facilityCaps?: ReadonlyMap<FacilityId, number>;
  rawCaps?: ReadonlyMap<ItemId, number>;
  manualRawMaterials?: ReadonlySet<ItemId>;
};

/** Injected dependencies shared by both engines. */
export type OptimizerOptions = {
  /** Solve a target vector into a plan. The hook passes a
   *  `calc-client.calculate` closure; tests pass
   *  `calculateProductionPlan` directly. Vectors include zero-rate
   *  entries (mirroring the UI calc effect — see `probeVector`) and
   *  are never empty. */
  solve: (targets: TargetVectorEntry[]) => Promise<ProductionDependencyGraph>;
  feasibility: FeasibilityContext;
  /** Checked before every solve; true aborts with `kind: "cancelled"`.
   *  The hook wires token + targets-identity staleness in here. */
  isCancelled?: () => boolean;
};

/**
 * The shared feasibility predicate — see the module doc and
 * `docs/plan-target-optimizer.md` ("Feasibility definition").
 *
 * Deliberately runs on the UNfiltered plan: `filterPlanForDisplay`
 * only drops zero-rate nodes, which contribute nothing to any of the
 * three checks, and `plan.bins` is identical either way.
 */
export function isPlanFeasible(
  plan: ProductionDependencyGraph,
  ctx: FeasibilityContext,
): boolean {
  // A failed solve returns a best-effort EMPTY shell (no bins, no
  // recipe nodes, zero rates) that would pass every cap check below
  // vacuously — that false "feasible" once let Max bracket to its
  // ceiling on a wedged solver and report "unbounded". Non-"ok" plans
  // are never feasible.
  if (plan.lpStatus !== "ok") return false;

  const aggregates = aggregateBinTotals(plan, ctx.facilities, ctx.items);
  if (
    computeOverCapWarnings(aggregates.physicalPerFacility, ctx.facilityCaps)
      .length > 0
  ) {
    return false;
  }

  // Raw requirements fold — mirrors `useProductionStats.collectStats`:
  // raw item nodes (plus manually-pinned raws) summed by productionRate.
  const rawRequirements = new Map<ItemId, number>();
  for (const node of plan.nodes.values()) {
    if (node.type !== "item") continue;
    if (node.isRawMaterial || ctx.manualRawMaterials?.has(node.itemId)) {
      rawRequirements.set(
        node.itemId,
        (rawRequirements.get(node.itemId) ?? 0) + node.productionRate,
      );
    }
  }
  if (computeRawOverCapWarnings(rawRequirements, ctx.rawCaps).length > 0) {
    return false;
  }

  for (const w of plan.warnings ?? []) {
    if (w.kind === "metastorage-budget-insufficient") return false;
  }
  return true;
}

/* ── Bisection engines ────────────────────────────────────────────── */

/**
 * Bracketing hard ceiling in items/min. The Max gating closure
 * over-approximates (it walks ALL alternative producers), so a plan
 * can pass the gate while no configured limit actually binds X — the
 * ceiling turns that case into `{ kind: "unbounded" }` instead of an
 * endless doubling. Injectable via `maxRateCeiling` so tests stay fast.
 */
const MAX_RATE_CEILING = 2 ** 20;

/** Milli-rate grid: 1 unit = 0.001 items/min (= the doc's PRECISION). */
const MILLI = 1000;

/** Base λ-bisection iteration budget for Fit: 2^-20 λ-resolution ≈
 *  milli-rate resolution for desired rates up to ~1000/min. Above
 *  that, `fitIterationsFor` adds bits so the λ grid stays at least as
 *  fine as the milli-rate grid (real plans do exceed 1000/min — e.g.
 *  Ferrium maxes at 1080/min under Valley IV default caps). Probes
 *  are memoized by the rounded-rate vector, so late iterations that
 *  collapse to the same vector cost no extra solve. */
const FIT_BASE_ITERATIONS = 20;

/** Iterations so that (max desired) × 2^-iterations ≤ 0.001/min, i.e.
 *  one λ-step never skips a milli-rate step for any scaled target.
 *  Capped defensively — memoization makes extra iterations cheap, but
 *  a pathological rate must not spin the loop unbounded. */
function fitIterationsFor(maxDesiredRate: number): number {
  const needed = Math.ceil(Math.log2(Math.max(1, maxDesiredRate * MILLI)));
  return Math.min(40, Math.max(FIT_BASE_ITERATIONS, needed + 1));
}

/** Floor a rate onto the milli grid. The epsilon absorbs binary-float
 *  representation drift (0.3 × 1000 = 299.9999…94 must floor to 300,
 *  not 299). */
function floorToMillis(rate: number): number {
  return Math.floor(rate * MILLI + 1e-6);
}

/** Internal cancellation sentinel — converted to `kind: "cancelled"`
 *  at the engine boundary, never escapes this module. */
class OptimizerCancelledError extends Error {
  constructor() {
    super("optimizer search cancelled");
    this.name = "OptimizerCancelledError";
  }
}

/**
 * Solve + feasibility-check one candidate vector.
 *
 * The vector is solved **exactly as given, zero-rate entries
 * included** — the UI calc effect passes every target (including
 * rate-0 ones) and a rate-0 target is NOT inert: the graph builder
 * roots reachability from it, pulling its whole producer closure into
 * the LP (extra columns, disposal-injection cascades, and the
 * forced-disposal `min: 0` → `disposal-slack: 0` constraint flip when
 * its chain adds a byproduct consumer). Probes must judge the SAME
 * problem the UI will solve after the commit, or a "verified feasible"
 * rate can re-solve over-cap (the SC-Wuling-Battery ratchet bug). Only
 * a truly empty target list short-circuits (`calculateProductionPlan`
 * throws on it; no targets = no demand = trivially feasible).
 *
 * A `solver_error` plan throws — it is evidence, not a verdict:
 * counting a wedged-solver shell as "infeasible" would corrupt the
 * bisection bracket. The hook's catch aborts the search with an error
 * toast. Ordinary solve rejections likewise propagate (see module
 * doc).
 */
async function probeVector(
  vector: TargetVectorEntry[],
  opts: OptimizerOptions,
): Promise<boolean> {
  if (opts.isCancelled?.()) throw new OptimizerCancelledError();
  if (vector.length === 0) return true;
  const plan = await opts.solve(vector);
  if (opts.isCancelled?.()) throw new OptimizerCancelledError();
  if (plan.lpStatus === "solver_error") {
    throw new Error(
      "optimizer probe hit a solver error (lpStatus=solver_error)",
    );
  }
  return isPlanFeasible(plan, opts.feasibility);
}

export type MaximizeResult =
  /** `rate` for X plus pass-2 recovery rates for unlocked others
   *  (index → new rate; indices absent = unchanged). `rate: 0` is a
   *  valid outcome: the locked targets alone exhaust the limits. */
  | { kind: "ok"; rate: number; otherRates: Map<number, number> }
  /** The locked targets alone (X at 0, unlocked others at 0) already
   *  blow the limits — nothing to maximize into. */
  | { kind: "infeasible" }
  /** Still feasible at the bracketing ceiling — no configured limit
   *  actually binds X's chain. */
  | { kind: "unbounded" }
  | { kind: "cancelled" };

/**
 * Priority-Max(X). Pass 1: bisect X's maximum with locked targets
 * frozen at their current rates and unlocked others at 0. Pass 2: pin
 * X at the result and run the Fit bisection over the unlocked others
 * (desired = their pre-Max rates) so they recover whatever X's chain
 * doesn't consume, ratios preserved.
 *
 * Semantics + algorithm: `docs/plan-target-optimizer.md`.
 */
export async function maximizeTargetRate(params: {
  targets: readonly OptimizableTarget[];
  /** Index of X in `targets`. X's own lock flag is irrelevant here —
   *  pressing Max on a target is an explicit edit of that target. */
  index: number;
  maxRateCeiling?: number;
  solve: OptimizerOptions["solve"];
  feasibility: FeasibilityContext;
  isCancelled?: () => boolean;
}): Promise<MaximizeResult> {
  const { targets, index, maxRateCeiling = MAX_RATE_CEILING } = params;
  const opts: OptimizerOptions = {
    solve: params.solve,
    feasibility: params.feasibility,
    isCancelled: params.isCancelled,
  };
  const x = targets[index];

  // Pass-1 probe vector: locked others frozen, unlocked others at an
  // EXPLICIT rate 0 — never omitted. Zero-rate targets still root the
  // graph traversal (see `probeVector`), and after a commit that
  // zeroes an unlocked target the UI solves with it present; the
  // probes must judge that same problem.
  const probeX = (millis: number) =>
    probeVector(
      targets.map((t, i) =>
        i === index
          ? { itemId: t.itemId, rate: millis / MILLI }
          : { itemId: t.itemId, rate: t.locked ? t.rate : 0 },
      ),
      opts,
    );

  try {
    const ceilingMillis = Math.max(MILLI, floorToMillis(maxRateCeiling));
    const curMillis = Math.min(
      floorToMillis(Math.max(0, x.rate)),
      ceilingMillis,
    );

    let lo: number; // verified feasible (or 0 after a verified base probe)
    let hi: number; // verified infeasible
    if (await probeX(curMillis)) {
      lo = curMillis;
      if (lo >= ceilingMillis) return { kind: "unbounded" };
      // Bracket upward: double until infeasible or the ceiling holds.
      hi = Math.min(Math.max(lo * 2, MILLI), ceilingMillis);
      for (;;) {
        if (await probeX(hi)) {
          lo = hi;
          if (hi >= ceilingMillis) return { kind: "unbounded" };
          hi = Math.min(hi * 2, ceilingMillis);
        } else {
          break;
        }
      }
    } else if (curMillis === 0 || !(await probeX(0))) {
      // X at 0 (= the locked-only base) is itself infeasible.
      return { kind: "infeasible" };
    } else {
      lo = 0;
      hi = curMillis; // current rate already verified infeasible
    }

    // Bisect on the milli grid; `lo` stays verified-feasible.
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (await probeX(mid)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const rate = lo / MILLI;

    // Pass 2 — leftover recovery for the unlocked others.
    const withX = targets.map((t, i) => (i === index ? { ...t, rate } : t));
    const fit = await fitTargetsToLimits({
      targets: withX,
      excludeIndex: index,
      solve: params.solve,
      feasibility: params.feasibility,
      isCancelled: params.isCancelled,
    });
    switch (fit.kind) {
      case "cancelled":
        return { kind: "cancelled" };
      case "ok":
        return { kind: "ok", rate, otherRates: fit.rates };
      case "noop":
        // X's maximum doesn't need the others' share — they keep their
        // current rates untouched.
        return { kind: "ok", rate, otherRates: new Map() };
      case "impossible":
        // A pass-2 "impossible" CONTRADICTS pass 1: fit's λ=0 vector
        // (X at `rate`, unlocked others at 0, locked frozen) is the
        // exact vector a pass-1 probe verified feasible moments ago —
        // and with an all-locked flexible set even its λ=1 vector is
        // that same vector. Two solves of identical input disagreed ⇒
        // the solver is unstable (wedged instance, timeout flap).
        // Committing here shipped an unverified value once (the
        // all-locked SC-Wuling-Battery bug: the wedge hit mid-search,
        // pass 2 read "infeasible" everywhere, and the old defensive
        // branch committed anyway). Abort instead — the hook surfaces
        // `optimizeFailed` and nothing is written.
        throw new Error(
          "optimizer pass-2 verification contradicted pass-1 (solver instability) — aborting without commit",
        );
    }
  } catch (e) {
    if (e instanceof OptimizerCancelledError) return { kind: "cancelled" };
    throw e;
  }
}

export type FitResult =
  /** New rates for the flexible targets (index → rate; all-zero is a
   *  valid result — the inflexible demands consume everything). */
  | { kind: "ok"; rates: Map<number, number> }
  /** The current vector already fits — nothing to do. */
  | { kind: "noop" }
  /** Infeasible even with every flexible target at 0: the locked +
   *  excluded demands alone exceed the limits. */
  | { kind: "impossible" }
  | { kind: "cancelled" };

/**
 * Fit-to-limits: scale all unlocked targets (minus `excludeIndex`) by
 * the largest feasible common λ ∈ [0, 1]. Candidate rates are floored
 * onto the milli grid; probes are memoized by the rounded-rate vector
 * signature; the returned vector is always one an actual solve
 * verified.
 *
 * Semantics + algorithm: `docs/plan-target-optimizer.md`.
 */
export async function fitTargetsToLimits(params: {
  targets: readonly OptimizableTarget[];
  /** Held at its current rate and never scaled: the just-edited target
   *  in auto-fit, or X in Max's pass 2. */
  excludeIndex?: number;
  solve: OptimizerOptions["solve"];
  feasibility: FeasibilityContext;
  isCancelled?: () => boolean;
}): Promise<FitResult> {
  const { targets, excludeIndex } = params;
  const opts: OptimizerOptions = {
    solve: params.solve,
    feasibility: params.feasibility,
    isCancelled: params.isCancelled,
  };

  // Flexible set: unlocked, not excluded, positive desired rate (a
  // zero-rate target scales to zero anyway — keep the write-set tight).
  const flexible: number[] = [];
  for (let i = 0; i < targets.length; i++) {
    if (i === excludeIndex) continue;
    const t = targets[i];
    if (!t.locked && t.rate > 0) flexible.push(i);
  }

  // Candidate vector at λ. λ = 1 uses the EXACT current rates (not
  // floored) — "noop" must mean "the plan as the user typed it fits",
  // not "fits after shaving sub-milli residue off the desired rates".
  const vectorAt = (
    lambda: number,
  ): { vector: TargetVectorEntry[]; rates: Map<number, number> } => {
    const rates = new Map<number, number>();
    for (const i of flexible) {
      rates.set(
        i,
        lambda >= 1
          ? targets[i].rate
          : floorToMillis(targets[i].rate * lambda) / MILLI,
      );
    }
    const vector = targets.map((t, i) => ({
      itemId: t.itemId,
      rate: rates.get(i) ?? t.rate,
    }));
    return { vector, rates };
  };

  const memo = new Map<string, boolean>();
  const probe = async (
    lambda: number,
  ): Promise<{ feasible: boolean; rates: Map<number, number> }> => {
    const { vector, rates } = vectorAt(lambda);
    const sig = vector.map((t) => t.rate).join(",");
    let feasible = memo.get(sig);
    if (feasible === undefined) {
      feasible = await probeVector(vector, opts);
      memo.set(sig, feasible);
    }
    return { feasible, rates };
  };

  try {
    // λ=1 runs BEFORE the empty-flexible-set check on purpose: with
    // nothing to scale, this single probe is still what decides
    // between "already fits" (noop) and "over-limit with no lever to
    // pull" (impossible) — it is the verdict, not a wasted solve.
    if ((await probe(1)).feasible) return { kind: "noop" };
    if (flexible.length === 0) return { kind: "impossible" };

    const zero = await probe(0);
    if (!zero.feasible) return { kind: "impossible" };

    let lo = 0;
    let hi = 1;
    let bestRates = zero.rates; // verified feasible
    const iterations = fitIterationsFor(
      flexible.reduce((max, i) => Math.max(max, targets[i].rate), 0),
    );
    for (let iter = 0; iter < iterations; iter++) {
      const mid = (lo + hi) / 2;
      const result = await probe(mid);
      if (result.feasible) {
        lo = mid;
        bestRates = result.rates;
      } else {
        hi = mid;
      }
    }
    return { kind: "ok", rates: bestRates };
  } catch (e) {
    if (e instanceof OptimizerCancelledError) return { kind: "cancelled" };
    throw e;
  }
}
