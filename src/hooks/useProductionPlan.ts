import { calculateProductionPlan } from "@/lib/calculator";
import { initHighs, isHighsReady } from "@/lib/highs-singleton";
import {
  items,
  recipes,
  facilities,
  forcedRawMaterials,
  MAX_TARGETS,
} from "@/data";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { toast } from "sonner";
import type { ProductionTarget } from "@/components/panels/TargetItemsGrid";
import type {
  Facility,
  FacilityId,
  ItemId,
  Recipe,
  RecipeId,
  PlanWarning,
  ProductionDependencyGraph,
  ProductionGraphNode,
} from "@/types";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useProductionStats } from "./useProductionStats";
import { useProductionTable } from "./useProductionTable";
import {
  getItemName,
  getFacilityName,
  getRecipeName,
} from "@/lib/i18n-helpers";
import {
  aggregateBinTotals,
  computeOverCapWarnings,
} from "@/lib/plan-helpers";
import { formatCount, getItemById } from "@/lib/utils";

interface SavedPlan {
  version: string;
  targets: { itemId: string; rate: number }[];
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
    const targetsRaw = params.get("t");
    const parsedTargets: ProductionTarget[] = [];
    if (targetsRaw) {
      for (const part of targetsRaw.split(",")) {
        const colonIdx = part.lastIndexOf(":");
        if (colonIdx === -1) continue;
        const itemId = part.slice(0, colonIdx) as ItemId;
        const rate = parseFloat(part.slice(colonIdx + 1));
        if (knownItemIds.has(itemId) && isFinite(rate) && rate >= 0) {
          parsedTargets.push({ itemId, rate });
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
    params.set("t", targets.map((t) => `${t.itemId}:${t.rate}`).join(","));
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
 * The single point where `ceilMode` (UI preference) and i18n strings
 * are applied to packer/calc-emitted warnings. Keeps the data layer
 * (`multi-formula-packing.ts`, `calculator.ts`) free of display state.
 *
 * Plural rules: i18next uses the `count` param for `_one` / `_other`
 * (and `_few` / `_many` in Russian). We pass `Math.ceil(used)` as
 * `count` so plurals classify on the integer physical count regardless
 * of `ceilMode`; the human-readable `displayCount` (which respects
 * `ceilMode`) drives the visible number.
 */
function formatPlanWarning(
  w: PlanWarning,
  ceilMode: boolean,
  t: TFunction,
  facilitiesArr: readonly Facility[],
): string {
  const lookupFacilityName = (id: FacilityId): string => {
    const facility = facilitiesArr.find((f) => f.id === id);
    return facility ? getFacilityName(facility) : id;
  };

  switch (w.kind) {
    case "facility-over-cap":
      // Short numeric form: `{facility}: cap exceeded ({displayCount} / {cap})`.
      // `displayCount` respects user's `ceilMode` toggle for parity with
      // the side-panel card count + tooltip. No plural classification
      // needed — the format string has no pluralizable noun.
      return t("facilityOverCap", {
        facility: lookupFacilityName(w.facilityId),
        displayCount: formatCount(w.used, ceilMode),
        cap: w.cap,
      });
    case "packer-override-infeasible":
      return t("packerOverrideInfeasible", {
        recipe: getRecipeName(w.recipeId),
        facility: lookupFacilityName(w.facilityId),
      });
    case "packer-fallback":
      return t("packerFallback");
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
 */
export function useProductionPlan(
  availableRecipes: readonly Recipe[],
  facilityCaps?: ReadonlyMap<FacilityId, number>,
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

  // HiGHS WASM solver is async. Kick off WASM init at mount time so
  // the first calculation has it ready; track readiness so we can
  // surface a "loading solver…" state instead of running calculations
  // against an uninitialised solver.
  const [solverReady, setSolverReady] = useState<boolean>(isHighsReady);
  useEffect(() => {
    if (isHighsReady()) return;
    let cancelled = false;
    initHighs()
      .then(() => {
        if (!cancelled) setSolverReady(true);
      })
      .catch((e) => {
        if (cancelled) return;
        // Log only. The solver-loading overlay over the production
        // area remains visible. Reaching here means the WASM
        // compile failed (near-zero probability in modern browsers);
        // a richer error UI is not worth the surface area until
        // real reports surface.
        console.error("[HIGHS] init failed:", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    if (targets.length === 0) {
      setPlan(null);
      setError(null);
      setIsCalculating(false);
      return;
    }
    let cancelled = false;
    setError(null);
    setIsCalculating(true);
    calculateProductionPlan(
      targets,
      items,
      availableRecipes,
      facilities,
      { recipeOverrides, manualRawMaterials, facilityCaps },
    )
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
        setError(e instanceof Error ? e.message : t("calculationError"));
        setPlan(null);
        setIsCalculating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    solverReady,
    targets,
    recipeOverrides,
    manualRawMaterials,
    availableRecipes,
    facilityCaps,
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

  useEffect(() => {
    let removedTargets = 0;
    let removedOverrides = 0;
    let removedRaws = 0;

    const nextTargets = targets.filter((t) =>
      reachableProducibleItems.has(t.itemId),
    );
    removedTargets = targets.length - nextTargets.length;

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
      // recipe in the strict `availableRecipes` set) OR a forced raw
      // (always-available — pin is redundant but harmless).
      //
      // Drop pins on items that are completely unreachable: no
      // available recipe produces them AND they aren't a forced raw.
      // Rationale: a manual-raw pin on an unproducible item is
      // meaningless — there's no chain to override. Since
      // `availableRecipes` is chain-filtered upstream (App layer),
      // a producibility check here naturally excludes recipes whose
      // own chain is broken.
      if (
        reachableProducibleItems.has(itemId) ||
        forcedRawMaterials.has(itemId)
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
            ? "Removed 1 item no longer producible by your current AIC settings."
            : `Removed ${total} items no longer producible by your current AIC settings.`,
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
    targets,
    recipeOverrides,
    manualRawMaterials,
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
  const displayPlan = useMemo(() => {
    if (!plan) return plan;

    // Build sets of items/recipes involved in invalid cycles — these must
    // not be filtered out so the user can see what went wrong.
    const invalidCycleItems = new Set<ItemId>();
    const invalidCycleRecipes = new Set<RecipeId>();
    for (const ic of plan.invalidCycles) {
      ic.involvedItemIds.forEach((id) => invalidCycleItems.add(id as ItemId));
      ic.involvedRecipeIds.forEach((id) => invalidCycleRecipes.add(id as RecipeId));
    }

    // Filter 0-rate nodes, but never filter out target items or invalid-cycle nodes
    const activeNodes = new Map<string, ProductionGraphNode>();
    for (const [key, node] of plan.nodes) {
      if (node.type === "recipe" && node.facilityCount === 0 && !invalidCycleRecipes.has(node.recipeId)) continue;
      if (node.type === "item" && node.productionRate === 0 && !plan.targets.has(node.itemId) && !invalidCycleItems.has(node.itemId)) continue;
      activeNodes.set(key, node);
    }
    // Filter edges that connect to removed nodes
    const activeEdges = plan.edges.filter(
      (edge) => activeNodes.has(edge.from) && activeNodes.has(edge.to)
    );
    return { ...plan, nodes: activeNodes, edges: activeEdges } as ProductionDependencyGraph;
  }, [plan]);

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

  // Structured cap-overflow signals. Lifted to its own memo so two
  // downstream consumers (the warnings string memo + the per-facility
  // map for the side-panel visual indicator) share one computation.
  const overCapWarnings = useMemo<readonly PlanWarning[]>(
    () =>
      aggregates
        ? computeOverCapWarnings(aggregates.rawPerFacility, facilityCaps)
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

  // Derive warning messages from invalid cycles (with translated item names)
  // plus any non-fatal warnings the calculator surfaced (e.g. packer
  // fallback warnings from `multi-formula-packing`) plus facility-cap
  // overflows detected here at the aggregate layer.
  //
  // Cycle warnings only fire for cycles caused by user recipe overrides
  // — pre-existing unsolvable cycles in the game data are not actionable
  // and are skipped. Structured warnings (packer + cap) are formatted
  // here with `ceilMode` + i18n via `formatPlanWarning`.
  //
  // Cap detection uses `aggregates.rawPerFacility` (mode-independent
  // raw LP counts), so it uniformly covers recipe bins AND pickup-point
  // source facilities (pump_1, pump_2, unloader_1) — the latter being
  // absent from `plan.bins` and therefore invisible to the packer's
  // earlier cap check.
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
      formatPlanWarning(w, ceilMode, t, facilities),
    );

    const capWarnings = overCapWarnings.map((w) =>
      formatPlanWarning(w, ceilMode, t, facilities),
    );

    return [...cycleWarnings, ...planWarnings, ...capWarnings];
  }, [plan, overCapWarnings, recipeOverrides, ceilMode, t]);

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

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSavePlan = useCallback(() => {
    const data: SavedPlan = {
      version: "1",
      targets: targets.map((t) => ({ itemId: t.itemId, rate: t.rate })),
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
              data.targets.map((t) => ({ itemId: t.itemId as ItemId, rate: t.rate })),
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
    ceilMode,
    setCeilMode,
    binFusion,
    setBinFusion,
    handleTargetChange,
    handleTargetRemove,
    handleBatchAddTargets,
    handleToggleRawMaterial,
    handleRecipeChange,
    handleAddClick,
    handleSavePlan,
    handleOpenPlan,
    isLoading,
  };
}
