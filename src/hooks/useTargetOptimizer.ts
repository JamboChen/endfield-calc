/**
 * Target-optimizer orchestration hook — Max / Fit / auto-fit.
 *
 * Owns everything between the user's optimize gestures and the
 * worker-side searches (`searchMaximize` / `searchFit` in
 * `calc-client.ts`, which run the pure engines from
 * `target-optimizer.ts` as single worker jobs):
 *
 *   - The pure bookkeeping (auto-fit one-shot guard, protected-demand
 *     exclusion, Max "done" marks) lives in the
 *     `optimizer-orchestration` reducer — a unit-tested transition
 *     table. This hook dispatches events; `useProductionPlan`'s target
 *     handlers report gestures via the `note*` callbacks.
 *   - The async-transport bookkeeping (search token, cancel handle,
 *     spinner state) stays here as refs/state — side effects can't
 *     live in a reducer.
 *
 * Staleness contract (the invariants that have produced real bugs):
 *
 *   - A running search dies when its inputs move: target-identity
 *     changes cancel via the `targetsRef` effect; problem-definition
 *     changes (caps, routes, recipes, region, power mode — i.e.
 *     `calcProblem` identity) cancel via `cancelActiveSearch`.
 *   - Commits are gated AFTER the await on token + captured targets
 *     identity — a result can be in flight when a cancel lands.
 *   - Errors: superseded → silent abort; anything else → error toast.
 *     Never "infeasible".
 *   - Both operations snapshot the pre-search targets array and offer
 *     Restore in the completion toast.
 */
import {
  isCalcSuperseded,
  searchFit,
  searchMaximize,
  type CalcProblem,
} from "@/lib/calc-client";
import {
  INITIAL_ORCHESTRATION_STATE,
  optimizerOrchestrationReducer,
} from "@/lib/optimizer-orchestration";
import { rawsInChainOf } from "@/lib/target-optimizer";
import { namespaceStorageKey } from "@/lib/storage-namespace";
import { getItemById } from "@/lib/utils";
import { getItemName } from "@/lib/i18n-helpers";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { ProductionTarget } from "@/components/panels/TargetItemsGrid";
import type { ItemId } from "@/types";

/** Auto-fit preference (Options card toggle). Channel-namespaced like
 *  every persisted key — see `storage-namespace.ts`. */
const AUTO_FIT_STORAGE_KEY = namespaceStorageKey("endfield-calc:auto-fit-v1");

/**
 * Debounce between "a settled calc result is over its limits" and the
 * auto-fit pass firing. Sits ON TOP of the scrub input's
 * trailing-throttle commit (`SCRUB_COMMIT_THROTTLE_MS`) — a scrub drag
 * keeps resetting this timer, so the fit runs once the user pauses,
 * not once per commit.
 */
const AUTO_FIT_DEBOUNCE_MS = 600;

/** Optimizer search in flight — drives per-button spinners and mutual
 *  exclusion (one search at a time). */
export type OptimizeState =
  | { kind: "max"; index: number }
  | { kind: "fit" }
  | null;

/** Stable empty set so the derived `maxedIndices` memo keeps identity
 *  while no marks apply. */
const EMPTY_INDEX_SET: ReadonlySet<number> = new Set();

export function useTargetOptimizer(params: {
  targets: ProductionTarget[];
  setTargets: Dispatch<SetStateAction<ProductionTarget[]>>;
  /** The single problem-definition bundle (also the config-staleness
   *  key) — the SAME memo the display calc consumes. */
  calcProblem: CalcProblem;
  /** Shared over-limit verdict off `plan.warnings` — the same clause
   *  as the engine's `isPlanFeasible`. */
  planOverLimit: boolean;
  /** Auto-fit judges settled results only. */
  isCalculating: boolean;
}) {
  const { targets, setTargets, calcProblem, planOverLimit, isCalculating } =
    params;
  const { t } = useTranslation("app");

  const [orchestration, dispatch] = useReducer(
    optimizerOrchestrationReducer,
    INITIAL_ORCHESTRATION_STATE,
  );

  const [optimizeState, setOptimizeState] = useState<OptimizeState>(null);
  /** The active search's cancel handle + captured targets snapshot.
   *  Null while no search runs. */
  const activeSearchRef = useRef<{
    cancel: () => void;
    captured: readonly ProductionTarget[];
  } | null>(null);
  const targetsRef = useRef(targets);
  useEffect(() => {
    targetsRef.current = targets;
    // Any targets-identity change invalidates a search captured on a
    // previous array (rate edits, add/remove index shifts, AND lock
    // toggles — the calc effect ignores lock-only changes via its
    // content signature, but the optimizer's flexible set does not).
    const active = activeSearchRef.current;
    if (active && active.captured !== targets) active.cancel();
  }, [targets]);
  /** Monotone search token: bumping it invalidates any in-flight
   *  search's commit (the worker-side loop is stopped separately via
   *  the search's `cancel()` handle). */
  const optimizeTokenRef = useRef(0);

  /* ── Gesture reporting (called by useProductionPlan's handlers) ── */

  /** The user scrub-committed / typed a rate for `index`. */
  const noteRateEdit = useCallback((index: number) => {
    dispatch({ type: "rate-edit", index });
  }, []);
  /** The user toggled a target's lock — see the reducer doc for why
   *  this re-arms AND clears the exclusion (both were real dead-ends). */
  const noteLockToggle = useCallback(() => {
    dispatch({ type: "lock-toggle" });
  }, []);
  /** The user removed a target (indices shift). */
  const noteTargetRemove = useCallback(() => {
    dispatch({ type: "target-remove" });
  }, []);
  /** The whole array was replaced — auto-prune (`disarm: false`) or
   *  plan load / Restore (`disarm: true`). */
  const resetEditContext = useCallback((options: { disarm: boolean }) => {
    dispatch({ type: "structural-replace", disarm: options.disarm });
  }, []);

  /* ── Marks ─────────────────────────────────────────────────────── */

  /** Marks apply only while the live `targets` IS the array they were
   *  computed against — any other identity silently invalidates. */
  const maxedIndices = useMemo<ReadonlySet<number>>(
    () =>
      orchestration.maxedMarks &&
      orchestration.maxedMarks.forTargets === targets
        ? orchestration.maxedMarks.indices
        : EMPTY_INDEX_SET,
    [orchestration.maxedMarks, targets],
  );

  /* ── Search lifecycle ──────────────────────────────────────────── */

  /** End-of-search bookkeeping, token-gated: when a superseding search
   *  took over, IT owns the busy state. */
  const finishOptimizeSearch = useCallback((token: number) => {
    if (optimizeTokenRef.current !== token) return;
    setOptimizeState(null);
  }, []);

  /**
   * Abort any in-flight search AND drop the "Max done" markers. The
   * targets-identity staleness guard covers target edits, but NOT
   * changes to the rest of the problem definition — a search probing
   * a stale options bundle could commit values the fresh problem
   * judges over-cap (the same probe≠UI mismatch class as the
   * zero-rate-target bug), so the effect below cancels it the moment
   * `calcProblem` changes identity. Must self-clean (unlike a
   * superseding search, a config-cancel has no successor whose finally
   * would clear `optimizeState`).
   */
  const cancelActiveSearch = useCallback(() => {
    optimizeTokenRef.current++;
    activeSearchRef.current?.cancel();
    dispatch({ type: "config-change" });
    setOptimizeState(null);
  }, []);

  // Problem-definition staleness — the mount-time invocation is a
  // no-op (no search, no marks).
  useEffect(() => {
    cancelActiveSearch();
  }, [calcProblem, cancelActiveSearch]);

  const handleMaximizeTarget = useCallback(
    async (index: number) => {
      const captured = targetsRef.current;
      const targetItem = captured[index];
      if (!targetItem) return;
      // A previous search may still be draining in the worker
      // (mutual-exclusion UI normally prevents this; defend anyway).
      activeSearchRef.current?.cancel();
      const token = ++optimizeTokenRef.current;
      setOptimizeState({ kind: "max", index });
      const handle = searchMaximize({
        targets: captured,
        index,
        ...calcProblem,
      });
      activeSearchRef.current = { cancel: handle.cancel, captured };
      try {
        const result = await handle.promise;
        // Commit gate: the search loop was stopped via `cancel()` on
        // staleness, but a result can already be in flight when the
        // cancel lands — never commit against moved targets or a
        // superseded token.
        if (
          optimizeTokenRef.current !== token ||
          targetsRef.current !== captured
        ) {
          return;
        }
        if (result.kind === "cancelled") return;
        // Deterministic terminal outcomes mark the index as "maxed":
        // re-pressing without changing anything would reproduce the
        // exact same answer (and burn the same solves). Cancelled and
        // solver-error outcomes never mark — retrying is their remedy.
        if (result.kind === "unbounded") {
          dispatch({ type: "max-marked", forTargets: captured, index });
          toast.info(t("maximizeNoLimit"));
          return;
        }
        if (result.kind === "infeasible") {
          dispatch({ type: "max-marked", forTargets: captured, index });
          toast.warning(t("maximizeInfeasible"));
          return;
        }
        const item = getItemById(calcProblem.items, targetItem.itemId);
        const itemLabel = item ? getItemName(item) : targetItem.itemId;
        // Pure noop: X is already at its maximum AND pass 2 didn't
        // move any other target (a repeat press on an already-Maxed
        // target returns the identical milli-grid value; exact
        // equality is deliberate — a hand-typed sub-milli rate
        // genuinely changes on the first press and noops thereafter).
        // Confirm instead of claiming a maximization happened; skip
        // the write entirely — no hash churn, nothing to Restore.
        const unchanged =
          result.rate === targetItem.rate &&
          [...result.otherRates].every(([i, r]) => captured[i]?.rate === r);
        if (unchanged) {
          dispatch({ type: "max-marked", forTargets: captured, index });
          toast.info(
            t("maximizeAlreadyMax", { item: itemLabel, rate: result.rate }),
          );
          return;
        }
        // Eager array (not a functional updater): the mark must be
        // keyed to the exact post-commit identity so it survives its
        // own write while any OTHER array invalidates it. Safe for the
        // same reason the Restore path writes a plain array — the
        // staleness guard aborts the search whenever `targets` moved
        // off `captured`.
        const committed = captured.map((tgt, i) => {
          if (i === index) return { ...tgt, rate: result.rate };
          const recovered = result.otherRates.get(i);
          return recovered !== undefined ? { ...tgt, rate: recovered } : tgt;
        });
        setTargets(committed);
        dispatch({ type: "max-marked", forTargets: committed, index });
        toast.success(
          t(
            result.otherRates.size > 0 ? "maximizedToWithFit" : "maximizedTo",
            { item: itemLabel, rate: result.rate },
          ),
          {
            action: {
              label: t("restore"),
              onClick: () => {
                // Whole-array replacement — same structural-change
                // hygiene as plan load: a remembered edit index would
                // point into the wrong array, and auto-fit must not
                // immediately re-shrink the values the user just
                // restored (that would make Restore a no-op). Writes
                // the EXACT captured array: identity-keyed Max marks
                // on it become valid again, by design.
                resetEditContext({ disarm: true });
                setTargets(captured);
              },
            },
          },
        );
      } catch (e) {
        if (isCalcSuperseded(e)) return;
        console.error("[OPTIMIZER] max search failed:", e);
        toast.error(t("optimizeFailed"));
      } finally {
        if (activeSearchRef.current?.cancel === handle.cancel) {
          activeSearchRef.current = null;
        }
        finishOptimizeSearch(token);
      }
    },
    [calcProblem, resetEditContext, finishOptimizeSearch, setTargets, t],
  );

  const handleFitToLimits = useCallback(
    async (excludeIndex?: number) => {
      const captured = targetsRef.current;
      activeSearchRef.current?.cancel();
      const token = ++optimizeTokenRef.current;
      setOptimizeState({ kind: "fit" });
      const handle = searchFit({
        targets: captured,
        excludeIndex,
        ...calcProblem,
      });
      activeSearchRef.current = { cancel: handle.cancel, captured };
      try {
        const result = await handle.promise;
        // Commit gate — see the Max handler.
        if (
          optimizeTokenRef.current !== token ||
          targetsRef.current !== captured
        ) {
          return;
        }
        if (result.kind === "cancelled") return;
        if (result.kind === "noop") {
          toast.info(t("fitNoop"));
          return;
        }
        if (result.kind === "impossible") {
          toast.warning(t("fitImpossible"));
          return;
        }
        setTargets((prev) =>
          prev.map((tgt, i) => {
            const fitted = result.rates.get(i);
            return fitted !== undefined ? { ...tgt, rate: fitted } : tgt;
          }),
        );
        toast.success(t("fitApplied"), {
          action: {
            label: t("restore"),
            onClick: () => {
              // See the Max Restore handler: structural replacement
              // clears the edit context and disarms auto-fit so the
              // restored (over-limit) snapshot isn't instantly
              // re-shrunk.
              resetEditContext({ disarm: true });
              setTargets(captured);
            },
          },
        });
      } catch (e) {
        if (isCalcSuperseded(e)) return;
        console.error("[OPTIMIZER] fit search failed:", e);
        toast.error(t("optimizeFailed"));
      } finally {
        if (activeSearchRef.current?.cancel === handle.cancel) {
          activeSearchRef.current = null;
        }
        finishOptimizeSearch(token);
      }
    },
    [calcProblem, resetEditContext, finishOptimizeSearch, setTargets, t],
  );

  /* ── Auto-fit ──────────────────────────────────────────────────── */

  const [autoFit, setAutoFitState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_FIT_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setAutoFit = useCallback((value: boolean) => {
    setAutoFitState(value);
    try {
      localStorage.setItem(AUTO_FIT_STORAGE_KEY, value ? "1" : "0");
    } catch {
      // Persistence is best-effort (private mode etc.).
    }
  }, []);

  // Fit pill visibility: over-limit with something to shrink, hidden
  // while auto-fit owns the job (the two would race).
  const showFitPill = useMemo<boolean>(
    () =>
      !autoFit &&
      planOverLimit &&
      targets.some((tgt) => !tgt.locked && tgt.rate > 0),
    [autoFit, planOverLimit, targets],
  );

  // Auto-fit: when a SETTLED calc result is over its limits, debounce
  // and run one fit pass excluding the just-edited target. One-shot
  // per edit (the reducer's `autoFitArmed` guard): if the plan is
  // still infeasible after the pass (e.g. everything else is locked →
  // "impossible"), stop until the next gesture re-arms. Rate edits,
  // target removals AND lock toggles all re-arm — unlocking a target
  // is precisely the "let auto-fit adjust this" gesture. Guard flips
  // re-run this effect (reducer state is a dep), so the timer is
  // rescheduled/cleared consistently — no stale closure reads.
  useEffect(() => {
    if (!autoFit || !planOverLimit) return;
    if (optimizeState !== null) return; // a search is already running
    if (isCalculating) return; // judge settled results only
    if (!orchestration.autoFitArmed) return;
    const excludeIndex = orchestration.lastEditedIndex ?? undefined;
    const hasFlexible = targets.some(
      (tgt, i) => i !== excludeIndex && !tgt.locked && tgt.rate > 0,
    );
    if (!hasFlexible) return;
    const timer = setTimeout(() => {
      dispatch({ type: "auto-fit-fired" });
      void handleFitToLimits(excludeIndex);
    }, AUTO_FIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    autoFit,
    planOverLimit,
    optimizeState,
    isCalculating,
    orchestration.autoFitArmed,
    orchestration.lastEditedIndex,
    targets,
    handleFitToLimits,
  ]);

  /* ── Max-button gating ─────────────────────────────────────────── */

  // A target's Max action only makes sense when at least one raw
  // material reachable in its production chain has a configured limit
  // — that is what makes "maximum" finite. (Facility caps and
  // metastorage budgets BOUND the eventual search, but do not ENABLE
  // it — see the `target-optimizer.ts` module doc.) The closure walks
  // every alternative producer, so this over-approximates toward
  // enabling — the engine's bracketing ceiling defends at runtime.
  //
  // Content-keyed on the target ITEM-ID set (the `targetsCalcSig`
  // pattern): gating is rate- and lock-independent, so scrub-commit
  // streams and lock toggles must not re-run the per-target chain
  // closures (each rebuilds a full producer index over `recipes`).
  const targetItemIdsSig = targets.map((tgt) => tgt.itemId).join(",");
  const maxEnabledByTarget = useMemo(() => {
    const out = new Map<ItemId, boolean>();
    const rawCaps = calcProblem.options.rawCaps;
    const cappedRaws = rawCaps ? [...rawCaps.keys()] : [];
    for (const target of targets) {
      if (out.has(target.itemId)) continue;
      if (cappedRaws.length === 0) {
        out.set(target.itemId, false);
        continue;
      }
      const chainRaws = rawsInChainOf(
        target.itemId,
        calcProblem.recipes,
        calcProblem.options.rawMaterials,
      );
      out.set(
        target.itemId,
        cappedRaws.some((raw) => chainRaws.has(raw)),
      );
    }
    return out;
    // `targetItemIdsSig` fully captures the item-id content the memo
    // body reads off the targets array (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetItemIdsSig, calcProblem]);

  return {
    optimizeState,
    maxedIndices,
    maxEnabledByTarget,
    handleMaximizeTarget,
    handleFitToLimits,
    showFitPill,
    autoFit,
    setAutoFit,
    noteRateEdit,
    noteLockToggle,
    noteTargetRemove,
    resetEditContext,
  };
}
