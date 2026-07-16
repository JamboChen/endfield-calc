import {
  calculate,
  initCalcEngine,
  isCalcEngineReady,
  isCalcSuperseded,
  searchFit,
  searchMaximize,
} from "@/lib/calc-client";
import { rawsInChainOf } from "@/lib/target-optimizer";
import { namespaceStorageKey } from "@/lib/storage-namespace";
import { items, recipes, facilities, powerFuels, MAX_TARGETS } from "@/data";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { toast } from "sonner";
import type { ProductionTarget } from "@/components/panels/TargetItemsGrid";
import type {
  Facility,
  FacilityId,
  Item,
  ItemId,
  Recipe,
  RecipeId,
  PlanWarning,
  ProductionDependencyGraph,
} from "@/types";
import type { MetastorageRouteConfig } from "@/types/metastorage";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useProductionStats } from "./useProductionStats";
import { useProductionTable } from "./useProductionTable";
import {
  getDomainName,
  getItemName,
  getFacilityName,
  getRecipeName,
} from "@/lib/i18n-helpers";
import {
  aggregateBinTotals,
  filterPlanForDisplay,
  OVER_LIMIT_WARNING_KINDS,
} from "@/lib/plan-helpers";
import { MIN_VISIBLE_RATE_PER_MIN } from "@/lib/flow-thresholds";
import { calcRate, getItemById } from "@/lib/utils";

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

/**
 * One read-only "Power Target" row: a battery the plan produces solely
 * to feed Thermal Banks under the self-sustaining-power option. Derived
 * from the display plan's power-generation recipe nodes; rendered by
 * `PowerTargetsSection` below the Production Targets (informational —
 * the LP sizes these, the user can't edit them).
 */
export type PowerTarget = {
  /** The battery being burned. */
  item: Item;
  /** Battery production consumed for power, items/min. */
  ratePerMinute: number;
  /** Thermal Bank count (fractional = duty cycle). */
  banks: number;
  /** Watts provided (`powerGeneration × banks`, fuel-limited). */
  watts: number;
  /** The Thermal Bank facility (for the localized name). */
  facility: Facility;
};

/** Optimizer search in flight — drives per-button spinners and mutual
 *  exclusion (one search at a time). */
export type OptimizeState =
  | { kind: "max"; index: number }
  | { kind: "fit" }
  | null;

/**
 * "Max done" marker: target indices whose Max search already reached a
 * deterministic terminal outcome (ok / already-at-max / infeasible /
 * unbounded) against the EXACT problem identified by `forTargets`.
 * Re-running Max for a marked index without changing anything would
 * reproduce the same answer, so the button disables.
 *
 * Validity is DERIVED, not cleared: a mark only applies while the live
 * `targets` array IS `forTargets` (identity). Any other array — rate
 * edit, add/remove, lock toggle, Fit commit, Restore, prune, plan load
 * — silently invalidates every mark; a Max commit marks against the
 * array it just committed, so it survives its own write. Config-bundle
 * changes (caps, routes, recipes, region, …) invalidate via
 * `cancelActiveSearch` (the F-series staleness set). `cancelled` and
 * solver-error outcomes never mark — retrying is their remedy.
 */
type MaxedMarks = {
  forTargets: readonly ProductionTarget[];
  indices: ReadonlySet<number>;
} | null;

/** Stable empty set so the derived `maxedIndices` memo keeps identity
 *  while no marks apply. */
const EMPTY_INDEX_SET: ReadonlySet<number> = new Set();

interface SavedPlan {
  version: string;
  /** `locked` is optional/additive: legacy saves omit it (= unlocked). */
  targets: { itemId: string; rate: number; locked?: boolean }[];
  recipeOverrides: Record<string, string>;
  manualRawMaterials: string[];
  ceilMode: boolean;
  /**
   * Optional. When absent (legacy saves predating bin-fusion), the
   * loader defaults to `true` (bin-fusion on) — matching the
   * `parseHash` default.
   */
  binFusion?: boolean;
  /**
   * Optional. Self-sustaining power (Thermal Bank battery burning).
   * When absent (legacy saves), defaults to `false` — matching the
   * `parseHash` default.
   */
  powerSustain?: boolean;
}

/**
 * A user-pinned (item, recipe) pair where the LP chose to produce zero
 * of the pinned recipe. The pin is a hard producer-set narrowing in
 * `availableProducersFor` (graph-builder.ts) — if any downstream
 * consumer of the pinned item has a bypass alternative the LP prefers
 * on the lex objective, the pinned item disappears from the plan
 * entirely and the pinned recipe's facility count clamps to 0.
 *
 * Detection predicate: `!plan.nodes.has(pinnedRecipeId)`. The
 * active-subgraph filter in `buildProductionGraph` (calculator.ts:668)
 * only adds recipe nodes with `fc > 0`, and the LP-side epsilon clamp
 * (`FACILITY_COUNT_EPSILON` in `lp-solver.ts:379`) zeroes sub-1e-6
 * outputs — so the predicate is exact, no thresholding required.
 *
 * Surfaced in the Production Table as a ghost row appended to the end
 * of the row list (see `ProductionTable.tsx`), with the same recipe
 * picker + reset affordance as normal rows.
 */
export type IneffectivePin = { itemId: ItemId; recipeId: RecipeId };

interface ParsedHashState {
  targets: ProductionTarget[];
  recipeOverrides: Map<ItemId, RecipeId>;
  manualRawMaterials: Set<ItemId>;
  ceilMode: boolean;
  binFusion: boolean;
  powerSustain: boolean;
}

function parseHash(): ParsedHashState {
  const defaultState: ParsedHashState = {
    targets: [],
    recipeOverrides: new Map(),
    manualRawMaterials: new Set(),
    ceilMode: false,
    // binFusion defaults to ON. The hash key `bf=0` opts out;
    // omitting `bf` (or setting `bf=1`) keeps the default ON.
    binFusion: true,
    // powerSustain defaults to OFF. The hash key `ps=1` opts in.
    powerSustain: false,
  };

  try {
    const hash = window.location.hash.slice(1); // remove leading '#'
    if (!hash) return defaultState;

    const params = new URLSearchParams(hash);
    const knownItemIds = new Set(items.map((item) => item.id));
    const knownRecipeIds = new Set(recipes.map((recipe) => recipe.id));

    // Parse targets: t=item_steel:6,item_glass:3
    // A trailing `l` on the rate marks the target as locked
    // (t=item_steel:6l). Backward AND forward compatible: old URLs have
    // no suffix (= unlocked), and old app versions reading a new URL
    // still get the rate via parseFloat("6l") === 6, merely dropping
    // the flag.
    const targetsRaw = params.get("t");
    const parsedTargets: ProductionTarget[] = [];
    if (targetsRaw) {
      for (const part of targetsRaw.split(",")) {
        const colonIdx = part.lastIndexOf(":");
        if (colonIdx === -1) continue;
        const itemId = part.slice(0, colonIdx) as ItemId;
        const rateStr = part.slice(colonIdx + 1);
        const locked = rateStr.endsWith("l");
        const rate = parseFloat(rateStr);
        if (knownItemIds.has(itemId) && isFinite(rate) && rate >= 0) {
          parsedTargets.push(
            locked ? { itemId, rate, locked: true } : { itemId, rate },
          );
        }
      }
    }

    // Parse recipeOverrides: r=item_steel:recipe_alloy
    const recipeRaw = params.get("r");
    const parsedRecipeOverrides = new Map<ItemId, RecipeId>();
    if (recipeRaw) {
      for (const part of recipeRaw.split(",")) {
        const colonIdx = part.indexOf(":");
        if (colonIdx === -1) continue;
        const itemId = part.slice(0, colonIdx) as ItemId;
        const recipeId = part.slice(colonIdx + 1) as RecipeId;
        if (knownItemIds.has(itemId) && knownRecipeIds.has(recipeId)) {
          parsedRecipeOverrides.set(itemId, recipeId);
        }
      }
    }

    // Parse manualRawMaterials: m=item_coal,item_wood
    const manualRaw = params.get("m");
    const parsedManualRawMaterials = new Set<ItemId>();
    if (manualRaw) {
      for (const rawId of manualRaw.split(",")) {
        const itemId = rawId as ItemId;
        if (knownItemIds.has(itemId)) {
          parsedManualRawMaterials.add(itemId);
        }
      }
    }

    // Parse ceilMode: c=1
    const ceilRaw = params.get("c");
    const parsedCeilMode = ceilRaw === "1";

    // Parse binFusion: bf=0 disables (default on).
    const binFusionRaw = params.get("bf");
    const parsedBinFusion = binFusionRaw !== "0";

    // Parse powerSustain: ps=1 enables (default off).
    const parsedPowerSustain = params.get("ps") === "1";

    return {
      targets: parsedTargets,
      recipeOverrides: parsedRecipeOverrides,
      manualRawMaterials: parsedManualRawMaterials,
      ceilMode: parsedCeilMode,
      binFusion: parsedBinFusion,
      powerSustain: parsedPowerSustain,
    };
  } catch {
    return defaultState;
  }
}

function serializeHash(
  targets: ProductionTarget[],
  recipeOverrides: Map<ItemId, RecipeId>,
  manualRawMaterials: Set<ItemId>,
  ceilMode: boolean,
  binFusion: boolean,
  powerSustain: boolean,
): string {
  const params = new URLSearchParams();

  if (targets.length > 0) {
    params.set(
      "t",
      targets
        .map((t) => `${t.itemId}:${t.rate}${t.locked ? "l" : ""}`)
        .join(","),
    );
  }

  if (recipeOverrides.size > 0) {
    params.set(
      "r",
      Array.from(recipeOverrides.entries())
        .map(([itemId, recipeId]) => `${itemId}:${recipeId}`)
        .join(","),
    );
  }

  if (manualRawMaterials.size > 0) {
    params.set("m", Array.from(manualRawMaterials).join(","));
  }

  if (ceilMode) {
    params.set("c", "1");
  }

  // Only emit `bf=0` when the user disabled bin-fusion. The default
  // (on) keeps the hash short.
  if (!binFusion) {
    params.set("bf", "0");
  }

  // Only emit `ps=1` when self-sustaining power is enabled (default off).
  if (powerSustain) {
    params.set("ps", "1");
  }

  return params.toString();
}


/**
 * Format one structured `PlanWarning` into a display string.
 *
 * The single point where i18n strings are applied to packer/calc-
 * emitted warnings. Keeps the data layer (`multi-formula-packing.ts`,
 * `calculator.ts`) free of display state. Deliberately `ceilMode`-free:
 * facility-cap numbers are physical integers and raw-cap numbers are
 * rates, so no branch depends on the display-rounding preference.
 */
function formatPlanWarning(
  w: PlanWarning,
  t: TFunction,
  facilitiesArr: readonly Facility[],
  itemsArr: readonly Item[],
): string {
  const lookupFacilityName = (id: FacilityId): string => {
    const facility = facilitiesArr.find((f) => f.id === id);
    return facility ? getFacilityName(facility) : id;
  };

  const lookupItemName = (id: ItemId): string => {
    const item = itemsArr.find((i) => i.id === id);
    return item ? getItemName(item) : id;
  };

  switch (w.kind) {
    case "facility-over-cap":
      // Short numeric form: `{facility}: cap exceeded ({displayCount} / {cap})`.
      // `used` is a physical placement count (always-ceiled integer,
      // mode-independent — see `BinAggregates.physicalPerFacility`),
      // so it renders as a plain integer in both display modes.
      return t("facilityOverCap", {
        facility: lookupFacilityName(w.facilityId),
        displayCount: String(w.used),
        cap: w.cap,
      });
    case "packer-override-infeasible":
      return t("packerOverrideInfeasible", {
        recipe: getRecipeName(w.recipeId),
        facility: lookupFacilityName(w.facilityId),
      });
    case "packer-fallback":
      return t("packerFallback");
    case "raw-over-cap":
      // Mirrors `facilityOverCap`: short numeric form
      // `{item}: limit exceeded ({used}/min / {cap}/min)`.
      // Always items/min; no ceilMode applies (caps are intrinsically
      // rate-based, not building-count-based).
      return t("rawOverCap", {
        item: lookupItemName(w.itemId),
        used: w.used.toFixed(1),
        cap: w.cap,
      });
    case "metastorage-budget-insufficient":
      // Per-delivery (game-native) TTV figures. The import was NOT
      // applied — the budget is a hard game constant — so this
      // explains why the affected demand is unsatisfied.
      return t("metastorageBudgetInsufficient", {
        item: lookupItemName(w.itemId),
        source: getDomainName(w.sourceDomain),
        needed: w.neededPerCycle.toFixed(0),
        cap: w.capPerCycle.toFixed(0),
      });
    case "metastorage-route-conflict":
      // The listed targets are import-only but Metastorage carries one
      // item type per source region — the plan can't satisfy them all.
      return t("metastorageRouteConflict", {
        items: w.itemIds.map(lookupItemName).join(", "),
      });
    case "power-sustain-unavailable":
      // Self-sustaining power was requested but no battery is
      // producible / raw / importable — the LP ran without a
      // power-balance row, so the plan's power is uncovered.
      return t("powerSustainUnavailable");
    case "power-sustain-insufficient":
      // Battery production is a suggestion — it never violates the
      // user's raw/facility limits. This reports the watts that could
      // NOT be funded from headroom under those limits.
      return t("powerSustainInsufficient", {
        watts: w.shortfallWatts.toFixed(0),
      });
  }
}

/**
 * Plan/recipe-calc state hook.
 *
 * `availableRecipes` is the AIC-filtered subset of game-data recipes
 * derived in `App.tsx` from the user's current research / domain
 * activation state. The calc, the auto-prune effect, and the
 * recipe-override picker all operate on this set; recipes outside it
 * cannot run in this plan.
 *
 * Why threaded as args instead of read from a global: the App layer
 * is the single source of truth that combines game data with user
 * settings. Globals would re-introduce cross-module state and break
 * the auto-prune signal.
 *
 * `facilityCaps` is the per-facility aggregated cap (sum across active
 * domains of `effectiveCaps[facilityId][domainId]`). Passed into
 * `calculateProductionPlan` → Phase 5 MIP. Optional and undefined when
 * the user has no caps configured.
 *
 * `rawMaterialCaps` is the per-(raw item) cap for the current region,
 * in items/min. Passed into `calculateProductionPlan` → LP (which adds
 * slack-based upper-bound constraints); residual overage comes back as
 * calculator-emitted `raw-over-cap` PlanWarnings (see
 * `computeLimitViolations` in plan-helpers). **No entry in this map =
 * no limit** for that item; items the user hasn't capped don't appear
 * here and don't trigger warnings. Optional and undefined when nothing
 * is capped.
 *
 * `metastorageRoutes` are the Metastorage import routes resolved for
 * the current region by App.tsx. Threaded into
 * `calculateProductionPlan` (which auto-selects each route's single
 * transferred item) and consulted by the auto-prune effect so an
 * import-only target survives while its route is live.
 */
export function useProductionPlan(
  availableRecipes: readonly Recipe[],
  regionRawMaterials: ReadonlySet<ItemId>,
  facilityCaps?: ReadonlyMap<FacilityId, number>,
  rawMaterialCaps?: ReadonlyMap<ItemId, number>,
  metastorageRoutes?: readonly MetastorageRouteConfig[],
) {
  const { t } = useTranslation("app");

  const initialState = useMemo(() => parseHash(), []);

  const [targets, setTargets] = useState<ProductionTarget[]>(
    initialState.targets,
  );
  const [recipeOverrides, setRecipeOverrides] = useState<Map<ItemId, RecipeId>>(
    initialState.recipeOverrides,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"table" | "tree">("table");
  const [manualRawMaterials, setManualRawMaterials] = useState<Set<ItemId>>(
    initialState.manualRawMaterials,
  );
  const [ceilMode, setCeilMode] = useState(initialState.ceilMode);
  const [binFusion, setBinFusion] = useState(initialState.binFusion);
  const [powerSustain, setPowerSustain] = useState(initialState.powerSustain);

  useEffect(() => {
    const hash = serializeHash(
      targets,
      recipeOverrides,
      manualRawMaterials,
      ceilMode,
      binFusion,
      powerSustain,
    );
    const newUrl = hash
      ? `${window.location.pathname}${window.location.search}#${hash}`
      : window.location.pathname + window.location.search;
    history.replaceState(null, "", newUrl);
  }, [targets, recipeOverrides, manualRawMaterials, ceilMode, binFusion, powerSustain]);

  // The calculation engine (HiGHS WASM inside the calc worker, with a
  // main-thread fallback — see `calc-client.ts`) initialises async.
  // Kick it off at mount time so the first calculation finds a warm
  // solver; track readiness so we can surface a "loading solver…"
  // state instead of running calculations against a cold engine.
  const [solverReady, setSolverReady] = useState<boolean>(isCalcEngineReady);
  useEffect(() => {
    if (isCalcEngineReady()) {
      setSolverReady(true);
      return;
    }
    let cancelled = false;
    initCalcEngine()
      .then(() => {
        if (!cancelled) setSolverReady(true);
      })
      .catch((e) => {
        if (cancelled) return;
        // Log only. The solver-loading overlay over the production
        // area remains visible. Reaching here means BOTH the worker
        // and the main-thread WASM fallback failed (near-zero
        // probability in modern browsers); a richer error UI is not
        // worth the surface area until real reports surface.
        console.error("[CALC] engine init failed:", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Solver-facing view of `targets`. Strips presentation-only fields
  // (`locked`) and keys identity on the CONTENT signature, so target
  // edits that don't change what the LP sees — lock toggles create a
  // new array/object identity to re-render and persist the hash's `l`
  // suffix — never re-run the calc effect below (a full HiGHS solve).
  // Content-keying mirrors App.tsx's `metastorageRouteSig` precedent.
  const targetsCalcSig = targets
    .map((t) => `${t.itemId}:${t.rate}`)
    .join(",");
  const calcTargets = useMemo(
    () => targets.map(({ itemId, rate }) => ({ itemId, rate })),
    // `targetsCalcSig` fully captures the solver-relevant content of
    // `targets` (see above); the body reads nothing else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetsCalcSig],
  );

  // The complete problem definition MINUS targets — the single bundle
  // consumed by BOTH the display calc effect and the optimizer probes
  // (`optimizerSolve`). Optimizer probes must judge the exact problem
  // the UI solves after a commit (the probe≡UI invariant — see
  // `target-optimizer.ts`); building the bundle once makes drift
  // between the two call sites structurally impossible. Its identity
  // doubles as the config-staleness key: the effect below
  // `optimizerSolve` cancels any in-flight search when it changes.
  const calcProblem = useMemo(
    () => ({
      items,
      recipes: availableRecipes,
      facilities,
      options: {
        rawMaterials: regionRawMaterials,
        rawCaps: rawMaterialCaps,
        recipeOverrides,
        manualRawMaterials,
        facilityCaps,
        metastorageRoutes,
        powerSustain: powerSustain ? { fuels: powerFuels } : undefined,
      },
    }),
    [
      availableRecipes,
      regionRawMaterials,
      rawMaterialCaps,
      recipeOverrides,
      manualRawMaterials,
      facilityCaps,
      metastorageRoutes,
      powerSustain,
    ],
  );

  // Core calculation: async because `calculateProductionPlan` awaits
  // HiGHS via the solver wrappers. `plan` / `error` are `useState`s
  // updated via effect rather than `useMemo` returns, because async
  // memoisation isn't a standard React pattern.
  const [plan, setPlan] = useState<ProductionDependencyGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Raw "calculation in flight" signal. `showLoadingOverlay` below
  // debounces this to avoid flashing the overlay on routine fast
  // recalcs.
  const [isCalculating, setIsCalculating] = useState(false);
  useEffect(() => {
    if (!solverReady) return;
    if (calcTargets.length === 0) {
      setPlan(null);
      setError(null);
      setIsCalculating(false);
      return;
    }
    let cancelled = false;
    setError(null);
    setIsCalculating(true);
    calculate({ targets: calcTargets, ...calcProblem })
      .then((result) => {
        // Cancelled means a newer calc has started (or unmount). Leave
        // `isCalculating` true so the debounced overlay state doesn't
        // restart its timer between back-to-back recalcs.
        if (cancelled) return;
        setPlan(result);
        setIsCalculating(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // Superseded = the calc-client's latest-wins solve slot
        // displaced this request in favour of a newer solve — which
        // carries the fresh answer. (Searches live in their own slot
        // and cannot displace solves — see `calc-client.ts`.) Keep
        // `isCalculating` true so the overlay debounce doesn't restart
        // between back-to-back recalcs.
        if (isCalcSuperseded(e)) return;
        setError(e instanceof Error ? e.message : t("calculationError"));
        setPlan(null);
        setIsCalculating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [solverReady, calcTargets, calcProblem, t]);

  // Auto-prune effect.
  //
  // When `availableRecipes` shrinks (user toggled a tech off, deactivated
  // a domain, etc., or loaded a URL/file plan whose targets reference
  // facilities the current settings don't unlock), drop any state that
  // can no longer be honoured:
  //   - targets whose item is not produced by any available recipe
  //   - recipeOverrides whose chosen recipe is no longer available
  //   - manualRawMaterials whose item exists in `items` but is neither
  //     a forced raw nor producible (defensive — the user's pin is
  //     respected unless the chain is genuinely broken)
  //
  // Fires a single sonner toast summarising the total removed. The
  // initial-mount fire-once is intentional: it surfaces "your URL/file
  // plan was incompatible with your saved AIC settings" without a
  // dedicated import-warning code path.
  //
  // **One render cycle**: this effect's setters fire after the first
  // render; React re-renders the hook with pruned state, then the calc
  // effect runs against clean inputs. A user may briefly see "error"
  // state if the calc effect raced to render first, but it self-heals
  // on the next render.
  const reachableProducibleItems = useMemo(() => {
    const out = new Set<ItemId>();
    for (const r of availableRecipes) {
      for (const o of r.outputs) out.add(o.itemId);
    }
    return out;
  }, [availableRecipes]);

  const availableRecipeIds = useMemo(
    () => new Set(availableRecipes.map((r) => r.id)),
    [availableRecipes],
  );

  // Items obtainable via a live Metastorage route. A target with no
  // local producer is still honourable while importable, so the prune
  // below must not drop it; disabling the route shrinks this set and
  // the prune then fires (mirroring the recipe-shrink behaviour).
  const metastorageImportableItems = useMemo(() => {
    const out = new Set<ItemId>();
    for (const route of metastorageRoutes ?? []) {
      for (const itemId of route.itemCosts.keys()) out.add(itemId);
    }
    return out;
  }, [metastorageRoutes]);

  // Auto-fit per-edit context (consumed by the auto-fit effect in the
  // optimizer block below). Declared up here because the auto-prune
  // effect must clear it on structural target changes.
  /** Index of the last user-edited target (the auto-fit demand). */
  const lastEditedIndexRef = useRef<number | null>(null);
  /** Auto-fit one-shot loop guard — re-armed by `handleTargetChange`. */
  const autoFitSpentRef = useRef(false);
  /**
   * Drop auto-fit's per-edit context after a STRUCTURAL targets change
   * (auto-prune, plan load): indices shifted or the whole array was
   * replaced, so the remembered "last edited" index would point
   * auto-fit's shrink-exclusion at the wrong target. `disarm`
   * additionally sets the one-shot guard: structural changes that are
   * not user edits (loading a plan) must not trigger an auto-fit pass
   * by themselves. Ref writes live in this callback because
   * react-hooks/immutability forbids them directly in effect BODIES
   * (deferred contexts like the auto-fit effect's timer callback are
   * exempt — that one spends the guard at fire time).
   */
  const resetAutoFitEditContext = useCallback(
    (options: { disarm: boolean }) => {
      lastEditedIndexRef.current = null;
      if (options.disarm) autoFitSpentRef.current = true;
    },
    [],
  );

  useEffect(() => {
    let removedOverrides = 0;
    let removedRaws = 0;

    const nextTargets = targets.filter(
      (t) =>
        reachableProducibleItems.has(t.itemId) ||
        metastorageImportableItems.has(t.itemId),
    );
    const removedTargets = targets.length - nextTargets.length;

    const nextOverrides = new Map<ItemId, RecipeId>();
    for (const [itemId, recipeId] of recipeOverrides) {
      if (availableRecipeIds.has(recipeId)) {
        nextOverrides.set(itemId, recipeId);
      } else {
        removedOverrides++;
      }
    }

    const nextRaws = new Set<ItemId>();
    for (const itemId of manualRawMaterials) {
      // Keep a manual raw iff the item is either producible (in
      // `reachableProducibleItems`, i.e. an output of at least one
      // recipe in the strict `availableRecipes` set) OR a region-
      // available raw (always-available in the current factory — pin
      // is redundant but harmless).
      //
      // Drop pins on items that are completely unreachable: no
      // available recipe produces them, not a regional raw, AND not
      // Metastorage-importable here. Rationale: a manual-raw pin on an
      // unsourceable item in the current region is meaningless — there's
      // no chain to override. Cuprium-in-Valley-IV pins get dropped
      // here; the user gets a toast and the affected target (if any) is
      // auto-pruned too. An importable item is a legitimate pin target
      // (hand-feed it as a raw, freeing the route for another item), so
      // it survives — symmetric with the target-prune predicate above.
      if (
        reachableProducibleItems.has(itemId) ||
        regionRawMaterials.has(itemId) ||
        metastorageImportableItems.has(itemId)
      ) {
        nextRaws.add(itemId);
      } else {
        removedRaws++;
      }
    }

    const total = removedTargets + removedOverrides + removedRaws;
    if (total === 0) return;

    if (removedTargets > 0) {
      // Pruning shifts indices — a stale `lastEditedIndexRef` would
      // point auto-fit's exclusion at the wrong target. Not a user
      // edit, so leave the one-shot guard alone.
      resetAutoFitEditContext({ disarm: false });
      setTargets(nextTargets);
    }
    if (removedOverrides > 0) setRecipeOverrides(nextOverrides);
    if (removedRaws > 0) setManualRawMaterials(nextRaws);

    toast.info(
      t("autoPruneSummary", {
        count: total,
        defaultValue:
          total === 1
            ? "Removed 1 item no longer producible by your current settings."
            : `Removed ${total} items no longer producible by your current settings.`,
      }),
    );
    // The effect is idempotent against its own output: when the setters
    // above fire, `targets` / `recipeOverrides` / `manualRawMaterials`
    // change identity → effect re-runs → recomputes the prune against
    // already-pruned state → `total === 0` → early return above, no
    // double toast. So declaring the full dep set is safe (and
    // ESLint-honest) — the second pass exits before any state writes.
  }, [
    reachableProducibleItems,
    availableRecipeIds,
    metastorageImportableItems,
    targets,
    recipeOverrides,
    manualRawMaterials,
    regionRawMaterials,
    resetAutoFitEditContext,
    t,
  ]);

  // Debounced overlay visibility: only flip true if `isCalculating`
  // stays true for >300ms. Sub-300ms calcs (the common case at
  // 65-230ms) resolve before the timer fires, so the overlay never
  // flashes for routine recalcs.
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(false);
  useEffect(() => {
    if (!isCalculating) {
      setShowLoadingOverlay(false);
      return;
    }
    const timer = setTimeout(() => setShowLoadingOverlay(true), 300);
    return () => clearTimeout(timer);
  }, [isCalculating]);

  // Combined "solver busy" signal consumed by the loading overlay.
  // True while any of:
  //   - WASM is still loading.
  //   - A calc is in flight and we have no plan to show underneath
  //     (typically the first calc after WASM ready). Skipping the
  //     debounce here avoids a blank gap between WASM-ready and the
  //     overlay re-engaging for users opening a saved plan on a
  //     slow connection.
  //   - A calc has exceeded the 300ms debounce threshold.
  const isLoading =
    !solverReady ||
    (isCalculating && plan === null) ||
    showLoadingOverlay;

  // Filter zero-rate nodes from the plan for display. Note: `plan.bins`
  // and `plan.recipeBinAllocations` are intentionally NOT filtered — Phase 3
  // only emits bins for recipes with positive slot demand (see
  // `multi-formula-packing.ts` `SLOT_DEMAND_EPSILON` guard), so every
  // surviving bin has a corresponding surviving recipe node. Downstream
  // hooks (`useProductionStats`, `useProductionTable`) consume `displayPlan`
  // for nodes/edges but read `plan.bins` for aggregates via
  // `aggregateBinTotals`, which is the single source of truth.
  const displayPlan = useMemo(
    () => (plan ? filterPlanForDisplay(plan) : plan),
    [plan],
  );

  // Set of item ids the user has pinned a recipe for. Threaded into the
  // Production Table so the recipe picker can render a reset affordance
  // for any pinned row (effective or ineffective). Set form keeps the
  // `has()` lookup O(1) inside the per-row map in the table.
  const pinnedItemIds = useMemo<ReadonlySet<ItemId>>(
    () => new Set(recipeOverrides.keys()),
    [recipeOverrides],
  );

  // Pinned (item, recipe) pairs the LP did NOT run. Emits a ghost row
  // at the end of the Production Table's row list so the user can see
  // and remove these otherwise-invisible pins. See `IneffectivePin`
  // for the detection rationale.
  //
  // Reads `displayPlan` (post-zero-filter) rather than the raw `plan`:
  // for recipe nodes the two are equivalent (calculator's active filter
  // already drops fc=0), but using `displayPlan` keeps this memo
  // consistent with the rest of the rendering pipeline.
  const ineffectivePins = useMemo<IneffectivePin[]>(() => {
    if (!displayPlan) return [];
    const out: IneffectivePin[] = [];
    for (const [itemId, recipeId] of recipeOverrides) {
      if (!displayPlan.nodes.has(recipeId)) out.push({ itemId, recipeId });
    }
    return out;
  }, [displayPlan, recipeOverrides]);

  // Single canonical `BinAggregates` per plan / ceilMode change. Lifted
  // here from `useProductionStats` + `useProductionTable` so the heavy
  // walk runs once per render (was twice — both view hooks called it
  // independently). Threaded down to both view hooks AND consumed by
  // the cap-overflow detection below.
  //
  // `displayPlan` (post-zero-filter) is intentionally used here so the
  // aggregates align with what the table/stats render. `plan.bins`
  // stays the same between `plan` and `displayPlan` (Phase 3 emits
  // bins only for positive-demand recipes), so the bin-walk is
  // identical; the pickup-point fold uses `node.productionRate` on
  // raw nodes which the filter preserves for raws.
  const aggregates = useMemo(
    () =>
      displayPlan
        ? aggregateBinTotals(displayPlan, facilities, items, { ceilMode })
        : null,
    [displayPlan, ceilMode],
  );

  // Read-only "Power Targets" rows (self-sustaining power): one row per
  // active burn fuel, sorted by watts provided. Empty when the option
  // is off, no plan exists, or no bank runs. Consumed by
  // `PowerTargetsSection` in the plan rail.
  const powerTargets = useMemo<PowerTarget[]>(() => {
    if (!powerSustain || !displayPlan) return [];
    const out: PowerTarget[] = [];
    for (const node of displayPlan.nodes.values()) {
      if (node.type !== "recipe" || !node.powerGeneration) continue;
      const input = node.recipe.inputs[0];
      if (!input) continue;
      const item = getItemById(items, input.itemId);
      if (!item) continue;
      const ratePerMinute =
        calcRate(input.amount, node.recipe.craftingTime) * node.facilityCount;
      if (ratePerMinute <= MIN_VISIBLE_RATE_PER_MIN) continue;
      out.push({
        item,
        ratePerMinute,
        banks: node.facilityCount,
        watts: node.powerGeneration * node.facilityCount,
        facility: node.facility,
      });
    }
    out.sort((a, b) => b.watts - a.watts);
    return out;
  }, [powerSustain, displayPlan]);

  // "No fuel available" marker for the Power Targets empty state —
  // mirrors the `power-sustain-unavailable` plan warning.
  const powerSustainUnavailable = useMemo<boolean>(
    () =>
      powerSustain &&
      (plan?.warnings ?? []).some(
        (w) => w.kind === "power-sustain-unavailable",
      ),
    [powerSustain, plan],
  );

  // Structured limit-violation warnings, read STRAIGHT off the plan:
  // `calculateProductionPlan` emits them at assembly via
  // `computeLimitViolations` (facility caps against always-ceiled
  // `physicalPerFacility`, raw caps against the raw-node requirement
  // fold) — the same single judge the optimizer's `isPlanFeasible`
  // probes read, so the badges and the engines cannot disagree.
  const limitViolationWarnings = useMemo<readonly PlanWarning[]>(
    () =>
      (plan?.warnings ?? []).filter((w) =>
        OVER_LIMIT_WARNING_KINDS.has(w.kind),
      ),
    [plan],
  );

  // Per-facility map for the side-panel `<ProductionStats>` card
  // styling — `Map<FacilityId, { used; cap }>` indexed for O(1) lookup
  // per facility card. Empty when no facility is over its cap.
  const facilityOverCapMap = useMemo<
    ReadonlyMap<FacilityId, { used: number; cap: number }>
  >(() => {
    const out = new Map<FacilityId, { used: number; cap: number }>();
    for (const w of limitViolationWarnings) {
      if (w.kind === "facility-over-cap") {
        out.set(w.facilityId, { used: w.used, cap: w.cap });
      }
    }
    return out;
  }, [limitViolationWarnings]);

  // Collect overridden item IDs from invalid cycles for table row styling.
  // Only the items whose recipe override caused the cycle get highlighted,
  // not every item caught in the cycle.
  const invalidCycleItemIds = useMemo(() => {
    const ids = new Set<ItemId>();
    if (plan) {
      for (const ic of plan.invalidCycles) {
        ic.overriddenItemIds.forEach((id) => ids.add(id as ItemId));
      }
    }
    return ids;
  }, [plan]);

  // View-specific data: computed in view layer hooks. Both receive
  // the shared `aggregates` so the table footer and stats panel
  // cannot drift — single source of truth, single compute per render.
  // `facilityOverCapMap` flows through stats so the side-panel
  // `<ProductionStats>` card can apply destructive styling to
  // over-cap facility cards.
  const stats = useProductionStats(
    displayPlan,
    aggregates,
    facilityOverCapMap,
    manualRawMaterials,
    items,
  );
  const tableData = useProductionTable(
    displayPlan,
    aggregates,
    // Narrow the recipe set the override dropdown searches over: only
    // recipes that are AIC-unlocked AND have reachable input chains
    // can be valid alternatives. Same canonical set the calc uses.
    availableRecipes,
    manualRawMaterials,
    invalidCycleItemIds,
  );

  // Cap-overflow issue count (facility + raw) for the stats tickers'
  // destructive badge. Cap overflows don't emit banner strings — the
  // over-cap stat rows (destructive outline + AlertTriangle) ARE the
  // warning surface — but the badge must still signal them while the
  // dock is collapsed / the portrait sheet is closed, where those rows
  // are invisible. Counted off the plan-emitted violation warnings
  // (the single judge — see `limitViolationWarnings`).
  const capIssueCount = useMemo<number>(
    () =>
      limitViolationWarnings.filter(
        (w) => w.kind === "facility-over-cap" || w.kind === "raw-over-cap",
      ).length,
    [limitViolationWarnings],
  );

  // Per-item {used, cap} for EVERY valid capped raw — the stats
  // surfaces' raw-material cards derive both the capacity bar
  // (headroom at a glance) and the over-cap state (used > cap + ε,
  // decided at the leaf) from this one map. Items without a cap have
  // no entry (= no limit, no bar).
  const rawMaterialCapMap = useMemo<
    ReadonlyMap<ItemId, { used: number; cap: number }>
  >(() => {
    const out = new Map<ItemId, { used: number; cap: number }>();
    if (!rawMaterialCaps) return out;
    for (const [itemId, cap] of rawMaterialCaps) {
      // Same validity guard as `computeRawOverCapWarnings`.
      if (!Number.isFinite(cap) || cap < 0) continue;
      out.set(itemId, {
        used: stats.rawMaterialRequirements.get(itemId) ?? 0,
        cap,
      });
    }
    return out;
  }, [rawMaterialCaps, stats.rawMaterialRequirements]);

  // Derive warning messages from invalid cycles (with translated item
  // names) plus any non-fatal warnings the calculator surfaced (e.g.
  // packer fallback warnings from `multi-formula-packing`).
  //
  // Cycle warnings only fire for cycles caused by user recipe overrides
  // — pre-existing unsolvable cycles in the game data are not actionable
  // and are skipped. Structured warnings (packer + metastorage) are
  // formatted here with i18n via `formatPlanWarning`.
  //
  // Cap overflows (facility + raw) deliberately do NOT emit banner
  // strings: the over-cap stat rows carry the destructive chrome +
  // exact numbers (tooltip / aria), and `capIssueCount` keeps the
  // ticker badge honest while those rows are hidden.
  const warnings: string[] = useMemo(() => {
    if (!plan) return [];
    const cycleWarnings = plan.invalidCycles
      .filter((ic) => ic.overriddenItemIds.length > 0)
      .map((ic) => {
        const overriddenSet = new Set(ic.overriddenItemIds);

        // Build "Item (Facility)" labels for overridden items
        const overriddenLabels = ic.overriddenItemIds
          .map((id) => {
            const item = getItemById(items, id as ItemId);
            const itemLabel = item ? getItemName(item) : id;
            const recipeId = recipeOverrides.get(id as ItemId);
            if (recipeId) {
              const recipe = recipes.find((r) => r.id === recipeId);
              if (recipe) {
                const facility = facilities.find(
                  (f) => f.id === recipe.facilityId,
                );
                if (facility) {
                  return `${itemLabel} (${getFacilityName(facility)})`;
                }
              }
            }
            return itemLabel;
          })
          .join(", ");

        // List the other affected items (excluding the overridden ones)
        const affectedLabels = ic.involvedItemIds
          .filter((id) => !overriddenSet.has(id))
          .map((id) => {
            const item = getItemById(items, id as ItemId);
            return item ? getItemName(item) : id;
          })
          .join(", ");

        if (affectedLabels) {
          return t("cycleWarning", {
            overriddenItems: overriddenLabels,
            affectedItems: affectedLabels,
          });
        }
        return t("cycleWarningNoAffected", {
          overriddenItems: overriddenLabels,
        });
      });

    // Cap kinds are excluded from the banner: the over-cap stat rows
    // (destructive chrome + exact numbers) are their surface, and
    // `capIssueCount` keeps the ticker badge honest while those rows
    // are hidden. They still live in `plan.warnings` — the calculator
    // emits them as the shared over-limit verdict (see
    // `limitViolationWarnings`).
    const planWarnings = (plan.warnings ?? [])
      .filter(
        (w) => w.kind !== "facility-over-cap" && w.kind !== "raw-over-cap",
      )
      .map((w) => formatPlanWarning(w, t, facilities, items));

    // Failed-solve banner. A non-"ok" `lpStatus` plan is an empty
    // best-effort shell (zero rates, no bins) that otherwise renders
    // as a silently-blank table — surface it UNLESS another warning
    // already explains the failure (pin-caused cycles or metastorage
    // budget/route problems carry more specific text).
    const lpStatusWarnings: string[] = [];
    if (
      plan.lpStatus !== "ok" &&
      cycleWarnings.length === 0 &&
      !(plan.warnings ?? []).some(
        (w) =>
          w.kind === "metastorage-budget-insufficient" ||
          w.kind === "metastorage-route-conflict",
      )
    ) {
      lpStatusWarnings.push(
        t(
          plan.lpStatus === "solver_error"
            ? "planSolverError"
            : "planLpInfeasible",
        ),
      );
    }

    return [...cycleWarnings, ...planWarnings, ...lpStatusWarnings];
  }, [plan, recipeOverrides, t]);

  // Power-deficit warning (self-sustaining power) — the residual
  // safety net: the calculator's ceil-floor loop normally sizes
  // generation to the whole-building consumption, so this only fires
  // when the loop hit its iteration cap with a gap left. Suppressed
  // while another surface already explains the state (no-fuel warning,
  // the cap-headroom `power-sustain-insufficient` warning, failed
  // solve).
  const powerWarnings = useMemo<string[]>(() => {
    if (!powerSustain || !plan || !aggregates) return [];
    if (plan.lpStatus !== "ok") return [];
    if (
      (plan.warnings ?? []).some(
        (w) =>
          w.kind === "power-sustain-unavailable" ||
          w.kind === "power-sustain-insufficient",
      )
    ) {
      return [];
    }
    const deficit = aggregates.totalPower - aggregates.totalPowerGeneration;
    // 0.5 W threshold: absorbs LP float noise while catching any real
    // ceiling-induced gap (the smallest power draw in the data is 5 W).
    if (deficit <= 0.5) return [];
    return [t("powerDeficit", { deficit: deficit.toFixed(0) })];
  }, [powerSustain, plan, aggregates, t]);

  const allWarnings = useMemo<string[]>(
    () => (powerWarnings.length > 0 ? [...warnings, ...powerWarnings] : warnings),
    [warnings, powerWarnings],
  );

  const handleTargetChange = useCallback((index: number, rate: number) => {
    // Auto-fit bookkeeping: the just-edited target is the demand — it
    // is excluded from auto-shrinking — and every manual edit re-arms
    // the one-shot loop guard.
    lastEditedIndexRef.current = index;
    autoFitSpentRef.current = false;
    setTargets((prev) =>
      // Clone the target object as well as the array so memoized consumers
      // that compare against `prev[index]` by reference see a new instance.
      prev.map((t, i) => (i === index ? { ...t, rate } : t)),
    );
  }, []);

  const handleTargetRemove = useCallback((index: number) => {
    // Removal shifts every higher index down — a stale
    // `lastEditedIndexRef` would make auto-fit exclude (and thereby
    // shrink-protect) the WRONG target. Clear it, and re-arm the
    // one-shot guard: removing a target is a user edit of the demand
    // set just like a rate change.
    lastEditedIndexRef.current = null;
    autoFitSpentRef.current = false;
    setTargets((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Toggle a target's lock flag. Locked targets are frozen under every
  // automatic adjustment (Fit scaling and priority-Max shrinking) —
  // see the `target-optimizer.ts` module doc.
  //
  // A lock toggle is a user edit of the ADJUSTABILITY contract, so it
  // re-arms auto-fit like a rate edit does (user-reported dead-end:
  // with auto-fit on and its one-shot guard already spent, unlocking a
  // target over a power shortfall did nothing — and the Fit pill was
  // hidden because auto-fit owns the job). It also clears the
  // last-edited exclusion: the just-unlocked target must be ELIGIBLE
  // for shrinking, not shielded as the protected demand (second
  // dead-end: unlock after scrubbing that same target's rate left no
  // flexible target for auto-fit to act on).
  const handleTargetLockToggle = useCallback((index: number) => {
    lastEditedIndexRef.current = null;
    autoFitSpentRef.current = false;
    setTargets((prev) =>
      prev.map((t, i) =>
        i === index
          ? t.locked
            ? { itemId: t.itemId, rate: t.rate }
            : { ...t, locked: true }
          : t,
      ),
    );
  }, []);

  const handleBatchAddTargets = useCallback(
    (newTargets: { itemId: ItemId; rate: number }[]) => {
      setTargets((prev) => {
        const existingIds = new Set(prev.map((t) => t.itemId));
        const unique = newTargets.filter((t) => !existingIds.has(t.itemId));
        return [...prev, ...unique].slice(0, MAX_TARGETS);
      });
    },
    [],
  );

  const handleRecipeChange = useCallback(
    (itemId: ItemId, recipeId: RecipeId) => {
      setRecipeOverrides((prev) => {
        const newMap = new Map(prev);
        newMap.set(itemId, recipeId);
        return newMap;
      });
    },
    [],
  );

  // Drop the user's pin for `itemId`. Triggered by the reset icon in
  // the Production Table's recipe picker (both normal rows and ghost
  // rows). The next calculation pass re-broadens the producer set for
  // `itemId` via `availableProducersFor` so the LP picks freely.
  const handleRecipePinReset = useCallback((itemId: ItemId) => {
    setRecipeOverrides((prev) => {
      if (!prev.has(itemId)) return prev;
      const newMap = new Map(prev);
      newMap.delete(itemId);
      return newMap;
    });
  }, []);

  const handleAddClick = useCallback(() => {
    setDialogOpen(true);
  }, []);

  const handleToggleRawMaterial = useCallback((itemId: ItemId) => {
    setManualRawMaterials((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  }, []);

  // Max-button gating: a target's Max action only makes sense when at
  // least one raw material reachable in its production chain has a
  // configured limit — that is what makes "maximum" finite. (Facility
  // caps and metastorage budgets BOUND the eventual search, but do not
  // ENABLE it — see the `target-optimizer.ts` module doc.) The closure walks
  // every alternative producer, so this over-approximates toward
  // enabling — the engine's bracketing ceiling defends at runtime.
  //
  // Content-keyed on the target ITEM-ID set (the `targetsCalcSig`
  // pattern): gating is rate- and lock-independent, so scrub-commit
  // streams and lock toggles must not re-run the per-target chain
  // closures (each rebuilds a full producer index over `recipes`).
  const targetItemIdsSig = targets.map((t) => t.itemId).join(",");
  const maxEnabledByTarget = useMemo(() => {
    const out = new Map<ItemId, boolean>();
    const cappedRaws = rawMaterialCaps ? [...rawMaterialCaps.keys()] : [];
    for (const target of targets) {
      if (out.has(target.itemId)) continue;
      if (cappedRaws.length === 0) {
        out.set(target.itemId, false);
        continue;
      }
      const chainRaws = rawsInChainOf(
        target.itemId,
        availableRecipes,
        regionRawMaterials,
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
  }, [targetItemIdsSig, availableRecipes, regionRawMaterials, rawMaterialCaps]);

  /* ── Target optimizer (Max / Fit) ─────────────────────────────────
   *
   * The bisection engines live in `@/lib/target-optimizer` and RUN IN
   * THE CALC WORKER as a single job each (`searchMaximize` /
   * `searchFit` in calc-client.ts); this block wires them to state +
   * toasts. Design & invariants: the `target-optimizer.ts` module doc.
   * Key hazards handled here:
   *
   *   - **Staleness**: a running search must die when its inputs move.
   *     Target edits (rate, add/remove, lock toggles) are caught by
   *     the `targetsRef` effect below — it cancels the active search
   *     whenever the live array's identity leaves the captured
   *     snapshot. Config changes cancel via `cancelActiveSearch`
   *     (keyed on `calcProblem`). Both paths also gate the COMMIT: the
   *     handlers re-check token + targets identity after the await,
   *     because a result can be in flight when the cancel lands.
   *   - **Errors**: superseded → silent abort (the user changed the
   *     problem); anything else → error toast. Never "infeasible".
   *   - **Undo**: both operations snapshot the pre-search targets array
   *     and offer Restore in the completion toast — priority-Max is a
   *     multi-value write.
   */
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
    // toggles — the calc effect ignores lock-only changes via
    // `targetsCalcSig`, but the optimizer's flexible set does not).
    const active = activeSearchRef.current;
    if (active && active.captured !== targets) active.cancel();
  }, [targets]);
  /** Monotone search token: bumping it invalidates any in-flight
   *  search's commit (the worker-side loop is stopped separately via
   *  the search's `cancel()` handle). */
  const optimizeTokenRef = useRef(0);
  // (`lastEditedIndexRef` / `autoFitSpentRef` are declared above the
  // auto-prune effect, which clears them on structural changes.)

  // "Max done" markers — see the `MaxedMarks` type doc. State (not a
  // ref) because it drives the Max buttons' disabled rendering.
  const [maxedMarks, setMaxedMarks] = useState<MaxedMarks>(null);
  /** Mark `index` as maxed against `forTargets`. Same-identity marks
   *  accumulate (Max A then Max B, both noop → both disabled); a new
   *  identity replaces the set. */
  const markMaxed = useCallback(
    (forTargets: readonly ProductionTarget[], index: number) => {
      setMaxedMarks((prev) =>
        prev && prev.forTargets === forTargets
          ? { forTargets, indices: new Set(prev.indices).add(index) }
          : { forTargets, indices: new Set([index]) },
      );
    },
    [],
  );
  const maxedIndices = useMemo<ReadonlySet<number>>(
    () =>
      maxedMarks && maxedMarks.forTargets === targets
        ? maxedMarks.indices
        : EMPTY_INDEX_SET,
    [maxedMarks, targets],
  );

  /** End-of-search bookkeeping, token-gated: when a superseding search
   *  took over, IT owns the busy state. */
  const finishOptimizeSearch = useCallback((token: number) => {
    if (optimizeTokenRef.current !== token) return;
    setOptimizeState(null);
  }, []);

  /**
   * Abort any in-flight search AND drop the "Max done" markers. The
   * targets-identity staleness guard covers target edits, but NOT
   * changes to the rest of the problem definition — caps, raw limits,
   * routes, available recipes, pins, manual raws, region. A search
   * probing a stale options bundle could commit values the fresh
   * problem judges over-cap (the same probe≠UI mismatch class as the
   * zero-rate-target bug), so the effect below cancels it the moment
   * `calcProblem` changes identity. Must self-clean (unlike a
   * superseding search, a config-cancel has no successor whose finally
   * would clear `optimizeState`).
   */
  const cancelActiveSearch = useCallback(() => {
    optimizeTokenRef.current++;
    activeSearchRef.current?.cancel();
    setMaxedMarks(null);
    setOptimizeState(null);
  }, []);

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

  // Problem-definition staleness: cancel any in-flight search (and drop
  // the "Max done" markers) whenever the options bundle changes
  // identity — see `cancelActiveSearch`. `calcProblem` IS the full
  // problem definition (caps, routes, recipes, pins, raws, power
  // mode) — the same bundle the searches capture at start. The
  // mount-time invocation is a no-op (no search, no marks).
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
      const handle = searchMaximize({ targets: captured, index, ...calcProblem });
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
          markMaxed(captured, index);
          toast.info(t("maximizeNoLimit"));
          return;
        }
        if (result.kind === "infeasible") {
          markMaxed(captured, index);
          toast.warning(t("maximizeInfeasible"));
          return;
        }
        const item = getItemById(items, targetItem.itemId);
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
          [...result.otherRates].every(
            ([i, r]) => captured[i]?.rate === r,
          );
        if (unchanged) {
          markMaxed(captured, index);
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
        markMaxed(committed, index);
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
                // restored (that would make Restore a no-op).
                resetAutoFitEditContext({ disarm: true });
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
    [
      calcProblem,
      resetAutoFitEditContext,
      finishOptimizeSearch,
      markMaxed,
      t,
    ],
  );

  const handleFitToLimits = useCallback(
    async (excludeIndex?: number) => {
      const captured = targetsRef.current;
      activeSearchRef.current?.cancel();
      const token = ++optimizeTokenRef.current;
      setOptimizeState({ kind: "fit" });
      const handle = searchFit({ targets: captured, excludeIndex, ...calcProblem });
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
              resetAutoFitEditContext({ disarm: true });
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
    [
      calcProblem,
      resetAutoFitEditContext,
      finishOptimizeSearch,
      t,
    ],
  );

  // Plan-over-limit signal shared by the Fit pill and auto-fit.
  // Literally the same clause as the engine's `isPlanFeasible`: the
  // calculator emits every limit violation into `plan.warnings`, and
  // `OVER_LIMIT_WARNING_KINDS` is the single source of truth for which
  // kinds count — the pill and the probes cannot disagree.
  const planOverLimit = useMemo<boolean>(
    () => limitViolationWarnings.length > 0,
    [limitViolationWarnings],
  );

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
  // and run one fit pass excluding the just-edited target. One-shot per
  // edit (`autoFitSpentRef`): if the plan is still infeasible after the
  // pass (e.g. everything else is locked → "impossible"), stop until
  // the next edit re-arms the guard. Rate edits, target removals AND
  // lock toggles all re-arm — unlocking a target is precisely the
  // "let auto-fit adjust this" gesture.
  useEffect(() => {
    if (!autoFit || !planOverLimit) return;
    if (optimizeState !== null) return; // a search is already running
    if (isCalculating) return; // judge settled results only
    if (autoFitSpentRef.current) return;
    const excludeIndex = lastEditedIndexRef.current ?? undefined;
    const hasFlexible = targets.some(
      (tgt, i) => i !== excludeIndex && !tgt.locked && tgt.rate > 0,
    );
    if (!hasFlexible) return;
    const timer = setTimeout(() => {
      autoFitSpentRef.current = true;
      void handleFitToLimits(excludeIndex);
    }, AUTO_FIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    autoFit,
    planOverLimit,
    optimizeState,
    isCalculating,
    targets,
    handleFitToLimits,
  ]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSavePlan = useCallback(() => {
    const data: SavedPlan = {
      version: "1",
      targets: targets.map((t) => ({
        itemId: t.itemId,
        rate: t.rate,
        ...(t.locked ? { locked: true } : {}),
      })),
      recipeOverrides: Object.fromEntries(recipeOverrides),
      manualRawMaterials: Array.from(manualRawMaterials),
      ceilMode,
      binFusion,
      powerSustain,
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "production-plan.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [targets, recipeOverrides, manualRawMaterials, ceilMode, binFusion, powerSustain]);

  const handleOpenPlan = useCallback(() => {
    if (!fileInputRef.current) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const data = JSON.parse(ev.target?.result as string) as SavedPlan;
            if (data.version !== "1") return;
            // Whole-array replacement: any remembered "last edited"
            // index now points into a different plan. Clear it and
            // disarm auto-fit until the user edits — loading an
            // over-limit plan is not an edit and must not trigger an
            // immediate rebalance.
            resetAutoFitEditContext({ disarm: true });
            setTargets(
              data.targets.map((t) =>
                t.locked === true
                  ? { itemId: t.itemId as ItemId, rate: t.rate, locked: true }
                  : { itemId: t.itemId as ItemId, rate: t.rate },
              ),
            );
            setRecipeOverrides(
              new Map(
                Object.entries(data.recipeOverrides).map(([k, v]) => [
                  k as ItemId,
                  v as RecipeId,
                ]),
              ),
            );
            setManualRawMaterials(new Set(data.manualRawMaterials as ItemId[]));
            setCeilMode(data.ceilMode);
            // Legacy saves (pre-bin-fusion) omit `binFusion`; default to on
            // to match `parseHash` and the in-app default.
            setBinFusion(data.binFusion ?? true);
            // Legacy saves omit `powerSustain`; default off (parseHash).
            setPowerSustain(data.powerSustain ?? false);
          } catch {
            // ignore invalid files
          }
        };
        reader.readAsText(file);
      };
      fileInputRef.current = input;
    }
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  }, [resetAutoFitEditContext]);

  return {
    targets,
    setTargets,
    recipeOverrides,
    setRecipeOverrides,
    dialogOpen,
    setDialogOpen,
    activeTab,
    setActiveTab,
    plan: displayPlan,
    tableData,
    stats,
    error,
    warnings: allWarnings,
    capIssueCount,
    rawMaterialCapMap,
    ceilMode,
    setCeilMode,
    binFusion,
    setBinFusion,
    powerSustain,
    setPowerSustain,
    powerTargets,
    powerSustainUnavailable,
    handleTargetChange,
    handleTargetRemove,
    handleTargetLockToggle,
    handleBatchAddTargets,
    maxEnabledByTarget,
    maxedIndices,
    optimizeState,
    handleMaximizeTarget,
    handleFitToLimits,
    showFitPill,
    autoFit,
    setAutoFit,
    handleToggleRawMaterial,
    handleRecipeChange,
    handleRecipePinReset,
    handleAddClick,
    handleSavePlan,
    handleOpenPlan,
    isLoading,
    pinnedItemIds,
    ineffectivePins,
  };
}
