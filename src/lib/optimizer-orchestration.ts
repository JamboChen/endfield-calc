/**
 * Optimizer orchestration state — the pure transition table behind
 * `useTargetOptimizer`.
 *
 * This is the bookkeeping that used to live in a web of refs inside
 * `useProductionPlan` (`autoFitSpentRef`, `lastEditedIndexRef`,
 * `maxedMarks`) whose correctness depended on comment-enforced
 * discipline about WHICH user gestures re-arm auto-fit and which
 * clear the protected-demand exclusion. Getting one transition wrong
 * produced real dead-ends (the lock-toggle bug: unlocking a target
 * over a power shortfall did nothing because only rate edits and
 * removals re-armed). As a reducer the rules are a unit-testable
 * table.
 *
 * What deliberately does NOT live here: the search token, the active
 * search's cancel handle, and `optimizeState` (the spinner state) —
 * those are async-transport bookkeeping tied to promise closures, and
 * a pure reducer cannot own side effects like cancelling a worker
 * job. The hook keeps them as refs/state next to the dispatch calls.
 *
 * Semantics (mirrors the auto-fit contract in `useTargetOptimizer`):
 *
 *   - `autoFitArmed` — the one-shot guard. An armed state lets ONE
 *     auto-fit pass fire once the plan settles over-limit; firing
 *     disarms. User edits of the demand set or the adjustability
 *     contract re-arm; structural replacements that are NOT user
 *     edits (plan load, Restore) disarm so loading an over-limit
 *     plan doesn't trigger an immediate rebalance.
 *   - `lastEditedIndex` — the just-edited target, auto-fit's
 *     protected demand (excluded from shrinking). Cleared whenever
 *     indices shift (removal, structural replace) or the user edits
 *     the adjustability contract (lock toggle — the just-unlocked
 *     target must be ELIGIBLE for shrinking, not shielded).
 *   - `maxedMarks` — Max-button "done" markers, keyed to the EXACT
 *     targets-array identity they were computed against. Validity is
 *     DERIVED by the consumer (marks apply only while the live array
 *     IS `forTargets`); the reducer only accumulates/replaces marks
 *     and drops them on config changes (a new problem definition
 *     invalidates every verdict).
 */
import type { OptimizableTarget } from "@/lib/target-optimizer";

export type MaxedMarks = {
  /** Structural (`OptimizableTarget`) rather than the UI's
   *  `ProductionTarget` — keeps the lib → component import out, same
   *  convention as `target-optimizer.ts`. Only the array IDENTITY is
   *  ever consumed (marks apply while the live array IS this one). */
  forTargets: readonly OptimizableTarget[];
  indices: ReadonlySet<number>;
} | null;

export type OptimizerOrchestrationState = {
  /** Auto-fit one-shot guard: true = a pass may fire on the next
   *  settled over-limit plan. */
  autoFitArmed: boolean;
  /** Auto-fit's protected demand (excluded from shrinking), or null. */
  lastEditedIndex: number | null;
  /** Max-button "done" markers — see the module doc. */
  maxedMarks: MaxedMarks;
};

export const INITIAL_ORCHESTRATION_STATE: OptimizerOrchestrationState = {
  // Armed at mount (matches the historical `autoFitSpentRef = false`
  // initial): file-based plan loads disarm via `structural-replace`,
  // while hash-parsed mount state stays armed — with auto-fit enabled
  // by the user, an over-limit URL plan rebalances once, which is the
  // pre-existing accepted behavior.
  autoFitArmed: true,
  lastEditedIndex: null,
  maxedMarks: null,
};

export type OptimizerEvent =
  /** The user scrub-committed / typed a rate for `index`. */
  | { type: "rate-edit"; index: number }
  /** The user toggled a target's lock — an edit of the ADJUSTABILITY
   *  contract: re-arms, and clears the exclusion so the just-unlocked
   *  target is eligible for shrinking. */
  | { type: "lock-toggle" }
  /** The user removed a target — indices shift, so the remembered
   *  exclusion would point at the wrong target. */
  | { type: "target-remove" }
  /** The whole array was replaced. `disarm: true` for non-edit
   *  replacements (plan load, Restore) — auto-fit must not instantly
   *  re-shrink what was just restored; `disarm: false` for auto-prune
   *  (indices shifted but the user didn't ask for anything). */
  | { type: "structural-replace"; disarm: boolean }
  /** The problem definition changed (caps, routes, recipes, region,
   *  power mode…): every Max verdict is stale. The hook additionally
   *  cancels the in-flight search — that side effect lives with the
   *  dispatch call, not here. */
  | { type: "config-change" }
  /** An auto-fit pass is firing NOW — spend the one-shot guard. */
  | { type: "auto-fit-fired" }
  /** A Max search reached a deterministic terminal outcome for
   *  `index` against `forTargets` — disable its button while the
   *  array identity holds. Same-identity marks accumulate; a new
   *  identity replaces the set. */
  | {
      type: "max-marked";
      forTargets: readonly OptimizableTarget[];
      index: number;
    };

export function optimizerOrchestrationReducer(
  state: OptimizerOrchestrationState,
  event: OptimizerEvent,
): OptimizerOrchestrationState {
  switch (event.type) {
    case "rate-edit":
      return {
        ...state,
        autoFitArmed: true,
        lastEditedIndex: event.index,
      };
    case "lock-toggle":
    case "target-remove":
      return {
        ...state,
        autoFitArmed: true,
        lastEditedIndex: null,
      };
    case "structural-replace":
      return {
        ...state,
        autoFitArmed: event.disarm ? false : state.autoFitArmed,
        lastEditedIndex: null,
      };
    case "config-change":
      return { ...state, maxedMarks: null };
    case "auto-fit-fired":
      return { ...state, autoFitArmed: false };
    case "max-marked": {
      const prev = state.maxedMarks;
      const indices =
        prev && prev.forTargets === event.forTargets
          ? new Set(prev.indices).add(event.index)
          : new Set([event.index]);
      return {
        ...state,
        maxedMarks: { forTargets: event.forTargets, indices },
      };
    }
  }
}
