/**
 * Layout cache + background prefetch for the dependency tree.
 *
 * The mapper → ELK → edge-styling pipeline is deterministic given
 * (plan, data rosters, targetRates, view options), yet the tree used to
 * recompute it from scratch on every Formula ↔ Facility switch AND on
 * every Production Table ↔ Dependency Tree tab flip (Radix unmounts the
 * inactive tab, discarding component state). This module provides:
 *
 *   - `computeFlowLayout` — the ONE pipeline implementation, shared by
 *     the interactive path (`ProductionDependencyTree`) and the
 *     background prefetch so the two can never drift.
 *   - a module-level cache keyed on the PLAN OBJECT IDENTITY via
 *     `WeakMap` — every re-solve produces a fresh plan object, so
 *     invalidation is automatic and old entries are garbage-collected
 *     with their plan; being module-level it survives the tree's
 *     unmount on tab switches. `targetRates` identity is stored as an
 *     extra guard: it can transiently change ahead of the async
 *     re-solve landing.
 *   - `useLayoutPrefetch` — speculative pre-computation of the views
 *     the user is likely to open next, on the DEDICATED "prefetch" ELK
 *     lane (own worker — never queues ahead of an interactive job).
 *     Concurrency policy, in order of defence:
 *       1. settle-debounce: nothing launches until inputs have been
 *          stable for `PREFETCH_SETTLE_MS` — rapid target-spam bumps
 *          the token and never starts speculative work;
 *       2. idle gate: the main-thread mapper portion waits for
 *          `requestIdleCallback`;
 *       3. single-flight: at most ONE prefetch job exists at any time;
 *       4. real cancellation: an input change while a job is mid-ELK
 *          calls `cancelLayoutLane("prefetch")` (worker terminated,
 *          lazily re-created) — a doomed multi-second NETWORK_SIMPLEX
 *          run does not keep grinding a core.
 *
 * Interactive misses deliberately do NOT await an in-flight prefetch of
 * the same combo: the tree computes independently on its own lane and
 * the prefetch drops its result if the entry appeared first
 * (`setCachedLayoutIfAbsent`). The duplicated work is confined to the
 * spare worker; the simpler protocol has no promotion states to get
 * wrong.
 */
import { useEffect, useRef } from "react";
import type { Edge, Node, Viewport } from "@xyflow/react";
import type {
  Facility,
  Item,
  ItemId,
  ProductionDependencyGraph,
  Recipe,
  VisualizationMode,
} from "@/types";
import {
  cancelLayoutLane,
  getLayoutedElements,
  LayoutCancelledError,
  type LayoutLane,
} from "@/lib/layout";
import {
  mapPlanToFlowBinFused,
  mapPlanToFlowBinFusedSeparated,
} from "../mappers/bin-fused-mapper";
import { mapPlanToFlowMerged } from "../mappers/merged-mapper";
import { applyEdgeStyling } from "./flow-utils";

export interface LayoutInputs {
  plan: ProductionDependencyGraph;
  items: Item[];
  recipes: readonly Recipe[];
  facilities: Facility[];
  targetRates: Map<ItemId, number> | undefined;
  visualizationMode: VisualizationMode;
  twoEndAlignment: boolean;
  ceilMode: boolean;
  binFusion: boolean;
}

export interface LayoutCacheEntry {
  nodes: Node[];
  edges: Edge[];
  /** Camera as the user last left this view; absent on prefetched /
   *  never-visited entries (callers fall back to their fit logic). */
  viewport?: Viewport;
}

/**
 * Option-combo cache key. `binFusion` is normalised out for the
 * separated mode — Facility View is ALWAYS bin-fused (documented mapper
 * invariant), so distinct bf values must share one entry instead of
 * duplicating compute.
 */
export function layoutComboKey(
  inputs: Pick<
    LayoutInputs,
    "visualizationMode" | "binFusion" | "twoEndAlignment" | "ceilMode"
  >,
): string {
  const bf =
    inputs.visualizationMode === "separated"
      ? "-"
      : inputs.binFusion
        ? "1"
        : "0";
  return `${inputs.visualizationMode}|${bf}|${inputs.twoEndAlignment ? 1 : 0}|${inputs.ceilMode ? 1 : 0}`;
}

type PlanCache = {
  targetRates: Map<ItemId, number> | undefined;
  entries: Map<string, LayoutCacheEntry>;
};

const cache = new WeakMap<ProductionDependencyGraph, PlanCache>();

function planCacheFor(inputs: LayoutInputs): PlanCache {
  let entry = cache.get(inputs.plan);
  if (!entry || entry.targetRates !== inputs.targetRates) {
    entry = { targetRates: inputs.targetRates, entries: new Map() };
    cache.set(inputs.plan, entry);
  }
  return entry;
}

export function getCachedLayout(
  inputs: LayoutInputs,
): LayoutCacheEntry | undefined {
  const planCache = cache.get(inputs.plan);
  if (!planCache || planCache.targetRates !== inputs.targetRates)
    return undefined;
  return planCache.entries.get(layoutComboKey(inputs));
}

/** Unconditional write — the interactive path and view snapshots own
 *  their entries (a snapshot carries drags + camera and must win). */
export function setCachedLayout(
  inputs: LayoutInputs,
  entry: LayoutCacheEntry,
): void {
  planCacheFor(inputs).entries.set(layoutComboKey(inputs), entry);
}

/** Prefetch write — never clobbers an entry the interactive path (or a
 *  snapshot) produced while the speculative job was in flight. */
function setCachedLayoutIfAbsent(
  inputs: LayoutInputs,
  entry: LayoutCacheEntry,
): void {
  const planCache = planCacheFor(inputs);
  const key = layoutComboKey(inputs);
  if (!planCache.entries.has(key)) planCache.entries.set(key, entry);
}

/**
 * The full display pipeline: mapper selection (same rules the tree
 * documented inline before extraction) → ELK layout on `lane` → edge
 * styling. Throws `LayoutCancelledError` if the lane is cancelled
 * mid-job.
 */
export async function computeFlowLayout(
  inputs: LayoutInputs,
  lane: LayoutLane,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const { plan, items, recipes, facilities, targetRates, ceilMode } = inputs;
  // Select mapper:
  //   - Facility View (separated) is ALWAYS bin-fused per the
  //     documented invariant; the Recipe-View toggle has no UI
  //     affordance in this mode and must not leak through when the
  //     user persisted bf=0 in the URL hash.
  //   - Recipe View (merged) with binFusion ON (default): one card
  //     per bin via the bin-fused merged mapper.
  //   - Recipe View (merged) with binFusion OFF: per-recipe via
  //     the original merged mapper (chain-debugging mode).
  const flowData =
    inputs.visualizationMode === "separated"
      ? mapPlanToFlowBinFusedSeparated(
          plan,
          items,
          recipes,
          facilities,
          targetRates,
          ceilMode,
        )
      : inputs.binFusion
        ? mapPlanToFlowBinFused(
            plan,
            items,
            recipes,
            facilities,
            targetRates,
            ceilMode,
          )
        : mapPlanToFlowMerged(plan, items, facilities, targetRates, ceilMode);

  const { nodes, edges } = await getLayoutedElements(
    flowData.nodes,
    flowData.edges,
    "RIGHT",
    inputs.twoEndAlignment,
    lane,
  );
  return { nodes, edges: applyEdgeStyling(edges, nodes) };
}

/** Inputs stable this long before a speculative job may launch. */
const PREFETCH_SETTLE_MS = 1500;
/** Idle-callback ceiling — busy pages still prefetch eventually. */
const PREFETCH_IDLE_TIMEOUT_MS = 2000;

function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), {
        timeout: PREFETCH_IDLE_TIMEOUT_MS,
      });
    } else {
      setTimeout(resolve, 200);
    }
  });
}

/** True while a prefetch job is inside the ELK stage — the only window
 *  where `cancelLayoutLane` buys anything (module-level: the hook may
 *  remount around an in-flight job). */
let prefetchElkInFlight = false;

/**
 * Speculatively pre-computes likely-next views into the layout cache.
 * Mount ONCE from a component that outlives tab switches
 * (`ProductionViewTabs`).
 */
export function useLayoutPrefetch(
  inputs: Omit<LayoutInputs, "plan"> & {
    plan: ProductionDependencyGraph | null;
    /** Current outer tab — on "table" the tree is unmounted, so its
     *  upcoming first render is prefetched too. */
    activeTab: "table" | "tree";
  },
): void {
  const tokenRef = useRef(0);
  const {
    plan,
    items,
    recipes,
    facilities,
    targetRates,
    visualizationMode,
    twoEndAlignment,
    ceilMode,
    binFusion,
    activeTab,
  } = inputs;

  useEffect(() => {
    const token = ++tokenRef.current;
    // A stale mid-ELK job burns a core for seconds — kill it now. An
    // idle lane is left alone (terminating it would only churn worker
    // startup).
    if (prefetchElkInFlight) {
      cancelLayoutLane("prefetch");
      prefetchElkInFlight = false;
    }
    if (!plan || plan.nodes.size === 0) return;

    const base: LayoutInputs = {
      plan,
      items,
      recipes,
      facilities,
      targetRates,
      visualizationMode,
      twoEndAlignment,
      ceilMode,
      binFusion,
    };
    // Priority order: the view a tab-switch would land on first, then
    // the other visualization mode.
    const targets: LayoutInputs[] = [];
    if (activeTab === "table") targets.push(base);
    targets.push({
      ...base,
      visualizationMode:
        visualizationMode === "separated" ? "merged" : "separated",
    });

    const timer = window.setTimeout(() => {
      void (async () => {
        for (const target of targets) {
          if (token !== tokenRef.current) return;
          if (getCachedLayout(target)) continue;
          await whenIdle();
          if (token !== tokenRef.current) return;
          try {
            prefetchElkInFlight = true;
            const result = await computeFlowLayout(target, "prefetch");
            prefetchElkInFlight = false;
            if (token !== tokenRef.current) return;
            setCachedLayoutIfAbsent(target, result);
          } catch (error) {
            prefetchElkInFlight = false;
            if (error instanceof LayoutCancelledError) return;
            // Speculative work — swallow anything else (the interactive
            // path will surface genuine failures if the user actually
            // opens the view).
            return;
          }
        }
      })();
    }, PREFETCH_SETTLE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    plan,
    items,
    recipes,
    facilities,
    targetRates,
    visualizationMode,
    twoEndAlignment,
    ceilMode,
    binFusion,
    activeTab,
  ]);
}
