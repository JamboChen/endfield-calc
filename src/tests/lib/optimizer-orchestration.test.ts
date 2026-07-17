/**
 * Transition-table tests for the optimizer orchestration reducer —
 * the bookkeeping that decides WHICH user gestures re-arm auto-fit,
 * which clear the protected-demand exclusion, and how Max "done"
 * marks accumulate/invalidate.
 *
 * These rules used to be comment-enforced ref discipline in
 * `useProductionPlan`; each transition asserted here maps to a real
 * behavior (and the lock-toggle case to a real user-reported bug).
 */
import { describe, test, expect } from "vitest";
import {
  INITIAL_ORCHESTRATION_STATE,
  optimizerOrchestrationReducer as reduce,
  type OptimizerEvent,
  type OptimizerOrchestrationState,
} from "@/lib/optimizer-orchestration";
import type { OptimizableTarget } from "@/lib/target-optimizer";

const targetsA: readonly OptimizableTarget[] = [
  { itemId: "item_a" as OptimizableTarget["itemId"], rate: 10 },
  { itemId: "item_b" as OptimizableTarget["itemId"], rate: 5 },
];
const targetsB: readonly OptimizableTarget[] = [...targetsA];

/** Fold a gesture sequence from the initial state. */
const run = (...events: OptimizerEvent[]): OptimizerOrchestrationState =>
  events.reduce(reduce, INITIAL_ORCHESTRATION_STATE);

describe("auto-fit guard (armed / spent)", () => {
  test("initial state is armed with no exclusion", () => {
    expect(INITIAL_ORCHESTRATION_STATE.autoFitArmed).toBe(true);
    expect(INITIAL_ORCHESTRATION_STATE.lastEditedIndex).toBeNull();
  });

  test("auto-fit-fired spends the guard; a rate edit re-arms and protects the edited index", () => {
    const spent = run({ type: "auto-fit-fired" });
    expect(spent.autoFitArmed).toBe(false);

    const rearmed = reduce(spent, { type: "rate-edit", index: 1 });
    expect(rearmed.autoFitArmed).toBe(true);
    expect(rearmed.lastEditedIndex).toBe(1);
  });

  test("target removal re-arms and clears the exclusion (indices shift)", () => {
    const s = run(
      { type: "rate-edit", index: 1 },
      { type: "auto-fit-fired" },
      { type: "target-remove" },
    );
    expect(s.autoFitArmed).toBe(true);
    expect(s.lastEditedIndex).toBeNull();
  });

  test("REGRESSION (lock-toggle dead-end): unlocking after a spent pass re-arms AND makes the toggled target eligible", () => {
    // The user-reported flow: scrub a target's rate (it becomes the
    // protected demand), auto-fit fires and concludes impossible
    // (guard spent), then the user unlocks/locks a target expecting a
    // rebalance. Pre-fix, nothing happened: only rate edits and
    // removals re-armed, and the exclusion kept shielding the very
    // target that should shrink.
    const s = run(
      { type: "rate-edit", index: 0 },
      { type: "auto-fit-fired" },
      { type: "lock-toggle" },
    );
    expect(s.autoFitArmed).toBe(true); // re-armed → a pass may fire
    expect(s.lastEditedIndex).toBeNull(); // index 0 no longer shielded
  });

  test("structural replace: plan load / Restore disarms; auto-prune preserves the guard", () => {
    // Plan load & Restore (disarm: true): loading an over-limit plan
    // is not an edit — no immediate rebalance.
    const loaded = run(
      { type: "rate-edit", index: 0 },
      { type: "structural-replace", disarm: true },
    );
    expect(loaded.autoFitArmed).toBe(false);
    expect(loaded.lastEditedIndex).toBeNull();

    // Auto-prune (disarm: false): indices shifted, exclusion must go,
    // but the guard keeps whatever state it had — armed…
    const prunedArmed = run(
      { type: "rate-edit", index: 1 },
      { type: "structural-replace", disarm: false },
    );
    expect(prunedArmed.autoFitArmed).toBe(true);
    expect(prunedArmed.lastEditedIndex).toBeNull();

    // …or spent.
    const prunedSpent = run(
      { type: "auto-fit-fired" },
      { type: "structural-replace", disarm: false },
    );
    expect(prunedSpent.autoFitArmed).toBe(false);
  });
});

describe("Max 'done' marks", () => {
  test("marks accumulate for the same targets identity", () => {
    const s = run(
      { type: "max-marked", forTargets: targetsA, index: 0 },
      { type: "max-marked", forTargets: targetsA, index: 1 },
    );
    expect(s.maxedMarks?.forTargets).toBe(targetsA);
    expect([...s.maxedMarks!.indices].sort()).toEqual([0, 1]);
  });

  test("a different array identity replaces the mark set (equal content is irrelevant)", () => {
    const s = run(
      { type: "max-marked", forTargets: targetsA, index: 0 },
      { type: "max-marked", forTargets: targetsB, index: 1 },
    );
    expect(s.maxedMarks?.forTargets).toBe(targetsB);
    expect([...s.maxedMarks!.indices]).toEqual([1]);
  });

  test("config-change drops all marks (a new problem invalidates every verdict) but keeps the edit context", () => {
    const s = run(
      { type: "rate-edit", index: 1 },
      { type: "max-marked", forTargets: targetsA, index: 0 },
      { type: "config-change" },
    );
    expect(s.maxedMarks).toBeNull();
    expect(s.lastEditedIndex).toBe(1);
    expect(s.autoFitArmed).toBe(true);
  });

  test("gesture events leave marks untouched — validity is derived by identity, not evented", () => {
    const s = run(
      { type: "max-marked", forTargets: targetsA, index: 0 },
      { type: "rate-edit", index: 1 },
      { type: "lock-toggle" },
      { type: "target-remove" },
      { type: "structural-replace", disarm: true },
      { type: "auto-fit-fired" },
    );
    // The marks survive in state; the consumer's identity comparison
    // (live targets !== targetsA after any of these gestures) is what
    // hides them. Keeping them lets Restore — which writes the EXACT
    // captured array back — re-validate marks keyed on it.
    expect(s.maxedMarks?.forTargets).toBe(targetsA);
  });
});
