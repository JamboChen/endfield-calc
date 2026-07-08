import {
  calculate,
  initCalcEngine,
  isCalcEngineReady,
  isCalcSuperseded,
} from "@/lib/calc-client";
import { rawsInChainOf } from "@/lib/target-optimizer";
import { items, recipes, facilities, MAX_TARGETS } from "@/data";
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
  computeOverCapWarnings,
  computeRawOverCapWarnings,
  filterPlanForDisplay,
} from "@/lib/plan-helpers";
import { getItemById } from "@/lib/utils";

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

    return {
      targets: parsedTargets,
      recipeOverrides: parsedRecipeOverrides,
      manualRawMaterials: parsedManualRawMaterials,
      ceilMode: parsedCeilMode,
      binFusion: parsedBinFusion,
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
 * slack-based upper-bound constraints) AND used here to compute
 * `raw-over-cap` PlanWarnings against post-pack
 * `rawMaterialRequirements`. **No entry in this map = no limit** for
 * that item; items the user hasn't capped don't appear here and don't
 * trigger warnings. Optional and undefined when nothing is capped.
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

  useEffect(() => {
    const hash = serializeHash(
      targets,
      recipeOverrides,
      manualRawMaterials,
      ceilMode,
      binFusion,
    );
    const newUrl = hash
      ? `${window.location.pathname}${window.location.search}#${hash}`
      : window.location.pathname + window.location.search;
    history.replaceState(null, "", newUrl);
  }, [targets, recipeOverrides, manualRawMaterials, ceilMode, binFusion]);

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
    calculate({
      targets: calcTargets,
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
      },
    })
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
        // Superseded = the calc-client's latest-wins queue displaced
        // this request in favour of a newer one; that newer request is
        // already carrying the fresh answer. Same treatment as
        // `cancelled`: keep `isCalculating` true so the overlay
        // debounce doesn't restart between back-to-back recalcs.
        if (isCalcSuperseded(e)) return;
        setError(e instanceof Error ? e.message : t("calculationError"));
        setPlan(null);
        setIsCalculating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    solverReady,
    calcTargets,
    recipeOverrides,
    manualRawMaterials,
    availableRecipes,
    regionRawMaterials,
    facilityCaps,
    rawMaterialCaps,
    metastorageRoutes,
    t,
  ]);

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

    if (removedTargets > 0) setTargets(nextTargets);
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

  // Structured facility-cap-overflow signals. Two downstream consumers
  // share this memo: `facilityOverCapMap` (the over-cap stat-row
  // chrome) and `capIssueCount` (the ticker's destructive badge).
  // Detection uses `aggregates.physicalPerFacility` (always-ceiled,
  // mode-independent placement counts): in-game caps are hard limits
  // on WHOLE buildings, and single-formula fragmentation can need more
  // placements than the fractional LP usage suggests (see the JSDoc on
  // `BinAggregates.physicalPerFacility`). Uniformly covers recipe bins
  // AND pickup-point source facilities (pump_1, pump_2, unloader_1) —
  // the latter being absent from `plan.bins` and therefore invisible
  // to the packer's earlier cap check.
  const overCapWarnings = useMemo<readonly PlanWarning[]>(
    () =>
      aggregates
        ? computeOverCapWarnings(aggregates.physicalPerFacility, facilityCaps)
        : [],
    [aggregates, facilityCaps],
  );

  // Per-facility map for the side-panel `<ProductionStats>` card
  // styling — `Map<FacilityId, { used; cap }>` indexed for O(1) lookup
  // per facility card. Empty when no facility is over its cap.
  const facilityOverCapMap = useMemo<
    ReadonlyMap<FacilityId, { used: number; cap: number }>
  >(() => {
    const out = new Map<FacilityId, { used: number; cap: number }>();
    for (const w of overCapWarnings) {
      if (w.kind === "facility-over-cap") {
        out.set(w.facilityId, { used: w.used, cap: w.cap });
      }
    }
    return out;
  }, [overCapWarnings]);

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
  // destructive badge. Cap overflows no longer emit banner strings —
  // the over-cap stat rows (destructive outline + AlertTriangle) ARE
  // the warning surface — but the badge must still signal them while
  // the dock is collapsed / the portrait sheet is closed, where those
  // rows are invisible.
  //
  // Raw side mirrors the facility check: compares the plan's post-pack
  // `stats.rawMaterialRequirements` (items/min consumption) against
  // the user's `rawMaterialCaps`. The LP layer additionally adds
  // slack-based upper-bound constraints (see `lp-solver.ts`), so the
  // LP biases toward conservation; this surfaces any residual overage.
  // **No entry in `rawMaterialCaps` = no limit**, structurally
  // enforced by `computeRawOverCapWarnings` iterating the caps map
  // rather than the requirements map.
  const capIssueCount = useMemo<number>(
    () =>
      overCapWarnings.length +
      computeRawOverCapWarnings(stats.rawMaterialRequirements, rawMaterialCaps)
        .length,
    [overCapWarnings, stats.rawMaterialRequirements, rawMaterialCaps],
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

    const planWarnings = (plan.warnings ?? []).map((w) =>
      formatPlanWarning(w, t, facilities, items),
    );

    return [...cycleWarnings, ...planWarnings];
  }, [plan, recipeOverrides, t]);

  const handleTargetChange = useCallback((index: number, rate: number) => {
    setTargets((prev) =>
      // Clone the target object as well as the array so memoized consumers
      // that compare against `prev[index]` by reference see a new instance.
      prev.map((t, i) => (i === index ? { ...t, rate } : t)),
    );
  }, []);

  const handleTargetRemove = useCallback((index: number) => {
    setTargets((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Toggle a target's lock flag. Locked targets are protected from the
  // (upcoming) Fit-to-limits rebalance — see docs/plan-target-optimizer.md.
  const handleTargetLockToggle = useCallback((index: number) => {
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
  // ENABLE it; see docs/plan-target-optimizer.md.) The closure walks
  // every alternative producer, so this over-approximates toward
  // enabling — the engine's bracketing ceiling defends at runtime.
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
  }, [targets, availableRecipes, regionRawMaterials, rawMaterialCaps]);

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
  }, [targets, recipeOverrides, manualRawMaterials, ceilMode, binFusion]);

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
  }, []);

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
    warnings,
    capIssueCount,
    rawMaterialCapMap,
    ceilMode,
    setCeilMode,
    binFusion,
    setBinFusion,
    handleTargetChange,
    handleTargetRemove,
    handleTargetLockToggle,
    handleBatchAddTargets,
    maxEnabledByTarget,
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
