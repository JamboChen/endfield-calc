import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import { items, recipes, facilities } from "./data";
import { useProductionPlan } from "./hooks/useProductionPlan";
import { usePortrait } from "./hooks/usePortrait";
import AppHeader from "./components/layout/AppHeader";
import MobileNav, { type MobileView } from "./components/layout/MobileNav";
import LeftPanel from "./components/panels/LeftPanel";
import PlanPanel from "./components/panels/PlanPanel";
import BottomDock from "./components/panels/BottomDock";
import PortraitDrawer from "./components/panels/PortraitDrawer";
import ProductionViewTabs from "./components/production/ProductionViewTabs";
import AddTargetDialogGrid from "./components/panels/AddTargetDialogGrid";
import AppFooter from "./components/layout/AppFooter";
import { SettingsSheet } from "./components/settings/SettingsSheet";
import { ThemeProvider } from "./components/ui/theme-provider";
import { useTheme } from "./components/ui/theme-context";
import { DomainSettingsProvider } from "./contexts/DomainSettingsProvider";
import { useDomainSettingsContext } from "./contexts/domain-settings-context";
import type { SettingsFocus } from "./contexts/settings-focus-context";
import {
  computeAvailableFacilities,
  computeRecipeAvailability,
} from "./lib/aic-research-helpers";
import { computeRecipeReachability } from "./lib/recipe-reachability";
import {
  computeTargetGatesForRegion,
  resolveGateAction,
} from "./lib/target-gate-helpers";
import { computeVariantExclusions } from "./lib/variant-filter";
import {
  bootstrapFacilities,
  defaultRawCapsByDomain,
  metastorageExports,
  metastorageSources,
  producibleRaws,
  rawAvailabilityByDomain,
  regionStructures,
} from "./data";
import { buildRawMaterialCaps } from "./lib/raw-limits-helpers";
import { structureKey } from "./lib/settings-helpers";
import { namespaceStorageKey } from "./lib/storage-namespace";
import type { FacilityId, Item, ItemId } from "./types";
import { DomainId } from "./types/constants";
import type { MetastorageRouteConfig } from "./types/metastorage";

/**
 * Producible raws that actually have a producing recipe in the roster
 * (Xiragen, Inergen — NOT the producer-less ores/sand/muck). Only these
 * are worth surfacing as pickable targets: a raw with no recipe would
 * just mine itself. Static (roster is a module constant), so computed
 * once at load. The Add-Target picker admits these past its region-raw
 * filter so a craftable raw can be requested as a production target.
 */
const producibleRawTargetIds: ReadonlySet<ItemId> = new Set(
  [...producibleRaws].filter((id) =>
    recipes.some((r) => r.outputs.some((o) => o.itemId === id)),
  ),
);

/**
 * Theme-aware Sonner toast portal. Lives inside ThemeProvider so it can
 * read the current theme. Top-right by default to avoid colliding with
 * the bottom-pinned LeftPanel collapse button and the portrait drawer.
 */
function ThemedToaster() {
  const { theme } = useTheme();
  return (
    <Toaster
      theme={theme === "dark" ? "dark" : "light"}
      position="top-right"
      richColors
      closeButton
      duration={4000}
    />
  );
}

/**
 * Inner App body. Reads domain settings from context and derives the
 * AIC-filtered recipe set + targetable item list before threading them
 * into the calc and the picker.
 *
 * Separated from `App` so that `useDomainSettingsContext()` can read
 * the provider's value (the hook errors when called above its provider).
 */
function AppContent() {
  const { i18n } = useTranslation("app");
  const settings = useDomainSettingsContext();

  // Canonical `availableRecipes` set used by the picker, the calc, the
  // recipe-override dropdown, and the auto-prune logic in
  // `useProductionPlan`. Composed in two stages:
  //
  //   1. `computeRecipeAvailability` filters the full game-data recipes
  //      by AIC unlock state (facility unlock + mode unlock).
  //   2. `computeRecipeReachability` further filters to recipes whose
  //      inputs are reachable from the per-region raw set via the AIC-
  //      filtered set, with one exception: recipes on `bootstrap
  //      Facilities` (e.g. Seed-Picking Unit) are unconditionally
  //      runnable when the facility is unlocked. This handles the
  //      planter↔seedcollector cycle that has no entry from raws —
  //      in-game the player seeds the cycle externally. See
  //      `bootstrapFacilities` in `@/data` for the rationale.
  //
  // Recipes with broken chains AND no bootstrap exception (e.g.
  // xiranite_oven_1 recipes when Furnace is locked → Carbon Enr
  // unreachable) are excluded, so the calc never sees them and the
  // picker never surfaces their outputs as targetable.
  //
  // Manual raws intentionally do NOT feed into this closure — they're
  // a plan-specific calc-time hint, not a configuration capability.
  // Pinning an unreachable intermediate as raw doesn't rescue a blocked
  // recipe; the dangling pin gets auto-pruned downstream.
  //
  // The intermediate AIC-only set is scoped to this memo only. Auto-
  // prune downstream operates on the strict `availableRecipes` outputs.

  // Per-region raw-material set used as the reachability closure's root
  // AND threaded through `useProductionPlan` → `calculateProductionPlan`
  // as the LP/graph raw classification. The "coverage" invariant in
  // `region-raw-availability.test.ts` guarantees every domain in the
  // registry has an entry here, so this `.get()` should never miss in
  // practice. Graceful fallback (empty set + dev warn) defends against
  // catastrophic data drift — a new domain landing without its raw
  // mapping would otherwise crash the app on render.
  const regionRawMaterials = useMemo(() => {
    const set = rawAvailabilityByDomain.get(settings.currentDomain);
    if (set) return set;
    if (import.meta.env?.DEV) {
      console.warn(
        `[App] rawAvailabilityByDomain missing entry for ${settings.currentDomain}; ` +
          "falling back to empty set. This violates the coverage invariant — " +
          "check region-raw-availability.test.ts for the failing case.",
      );
    }
    return new Set<ItemId>();
  }, [settings.currentDomain]);

  // Recipe-variant exclusions for the App layer's filter on
  // `availableRecipes`. Resolves the user's Settings state into the
  // two per-facility signals `computeVariantExclusions` needs
  // (`structure-aware` mode):
  //   - `availableInstances`: facilities with ≥1 enabled `instance`
  //     structure (e.g. ≥1 Sewage Inlet enabled → LIQUID_CLEAN_GATE_1
  //     is in the set). Drives "is the facility physically present?".
  //   - `toggledFacilities`: facilities whose `recipeToggle` structure
  //     is enabled (e.g. Byproduct Outlet on → LIQUID_CLEAN_GATE_1 is
  //     in the set). Makes the `toggled` variant ADDITIONALLY available
  //     alongside the `default` (additive — issue #90), not a swap.
  //
  // Why this lives at the App layer (alongside the existing AIC filter):
  // the calc / graph-builder / LP all operate on whatever recipe set
  // they're given. Filtering here keeps the algorithm code decoupled
  // from Settings semantics and mirrors how `computeRecipeAvailability`
  // already gates on AIC unlocks. The filter is sound regardless of
  // whether the facility itself is region-available — the AIC /
  // reachability passes will drop the recipes anyway when its facility
  // isn't reachable, so an excess entry here is harmless.
  //
  // A `recipeToggle` without any `instance` is degenerate (the Settings
  // UI cascade prevents enabling the outlet without all inlets);
  // `computeVariantExclusions` defends against it by treating missing
  // `availableInstances` as "exclude both variants" regardless of
  // toggle state.
  const structureVariantExcluded = useMemo(() => {
    const availableInstances = new Set<FacilityId>();
    const toggledFacilities = new Set<FacilityId>();
    for (const [domainId, list] of regionStructures) {
      if (!settings.activeDomains.has(domainId)) continue;
      for (const s of list) {
        if (!settings.structures.enabled.has(structureKey(domainId, s.id))) {
          continue;
        }
        if (s.solver.role === "instance") {
          availableInstances.add(s.solver.facilityId);
        } else if (s.solver.role === "recipeToggle") {
          toggledFacilities.add(s.solver.facilityId);
        }
      }
    }
    return computeVariantExclusions({
      mode: "structure-aware",
      availableInstances,
      toggledFacilities,
    });
  }, [settings.activeDomains, settings.structures.enabled]);

  // Source regions whose Metastorage transfer feeds the current
  // factory region: has capability (`metastorageSources`), isn't the
  // planned region, is active, route mode is "auto" or locked to this
  // region, and exports ≥1 modeled item. This recomputes on every
  // route-mode edit, but it's a tiny array — the heavy `metastorageRoutes`
  // build below keys on its CONTENT signature so an edit that doesn't
  // change the resolved source set never re-triggers the calc.
  const metastorageRouteSources = useMemo(() => {
    const out: DomainId[] = [];
    for (const source of metastorageSources.keys()) {
      if (source === settings.currentDomain) continue;
      if (!settings.activeDomains.has(source)) continue;
      const mode = settings.metastorage.routeModes.get(source) ?? "auto";
      if (mode !== "auto" && mode !== settings.currentDomain) continue;
      if (!metastorageExports.get(source)?.size) continue;
      out.push(source);
    }
    return out;
  }, [
    settings.currentDomain,
    settings.activeDomains,
    settings.metastorage.routeModes,
  ]);

  // Content signature of the resolved source set. `itemCosts` /
  // budget / cycle are all static per source (`metastorageExports` +
  // `metastorageSources`), so the source-id list fully determines the
  // route configs — keying the memo on this string keeps the
  // `metastorageRoutes` identity (and thus the calc-effect input)
  // stable across no-op route-mode edits (e.g. toggling a source the
  // current region doesn't import from).
  const metastorageRouteSig = metastorageRouteSources.join("|");

  // Resolved route configs for the calculator. Each carries the full
  // eligible item → TTV-cost map; the calculator auto-selects the
  // single transferred item per route (`selectMetastorageImports`).
  const metastorageRoutes = useMemo(() => {
    return metastorageRouteSources.map((source): MetastorageRouteConfig => {
      const info = metastorageSources.get(source)!;
      return {
        sourceDomain: source,
        ttvBudgetPerMinute: info.ttvCapPerCycle / (info.cycleSeconds / 60),
        cycleSeconds: info.cycleSeconds,
        itemCosts: metastorageExports.get(source)!,
      };
    });
    // `metastorageRouteSources` is fully captured by `metastorageRouteSig`
    // (see above); the body reads only static data otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metastorageRouteSig]);

  // Items obtainable via the resolved Metastorage routes. Seeds the
  // reachability closure (configuration-level capability, unlike
  // manual raws) so recipes consuming them become runnable and the
  // items themselves targetable even with no local producer; also
  // keeps the auto-prune effect from dropping import-only targets.
  const metastorageSeedItems = useMemo(() => {
    const out = new Set<ItemId>();
    for (const route of metastorageRoutes) {
      for (const itemId of route.itemCosts.keys()) out.add(itemId);
    }
    return out;
  }, [metastorageRoutes]);

  const { availableRecipes, reachableItems, metastorageOnlyItemIds } =
    useMemo(() => {
      // Intersect AIC-unlocked with region-permitted facilities so
      // recipes whose host facility is locked to a region the player
      // isn't currently building in drop from `availableRecipes`. See
      // `computeAvailableFacilities` for the rule.
      const availableFacilities = computeAvailableFacilities(
        settings.aic.unlockedFacilities,
        facilities,
        settings.currentDomain,
      );
      const aicFiltered = computeRecipeAvailability(
        recipes,
        availableFacilities,
        settings.aic.unlockedModes,
      ).availableRecipes;
      // Apply the structure-variant filter BEFORE reachability so any
      // excluded variant can't leak into the reachable set or the LP. (With
      // the toggle ON nothing is excluded — both variants are kept; see
      // `computeVariantExclusions`.)
      const variantFiltered = aicFiltered.filter(
        (r) => !structureVariantExcluded.has(r.id),
      );
      const { runnableRecipes, reachableItems } = computeRecipeReachability(
        variantFiltered,
        regionRawMaterials,
        bootstrapFacilities,
        metastorageSeedItems,
      );
      // Second closure WITHOUT the Metastorage import seeds: items that
      // fall out of reach when the imports are removed are available in
      // this region ONLY via Metastorage Transfer (directly imported, or
      // crafted locally from an imported input). The picker badges them.
      const { reachableItems: reachableWithoutMetastorage } =
        computeRecipeReachability(
          variantFiltered,
          regionRawMaterials,
          bootstrapFacilities,
        );
      const metastorageOnlyItemIds = new Set<ItemId>();
      for (const id of reachableItems) {
        if (!reachableWithoutMetastorage.has(id)) metastorageOnlyItemIds.add(id);
      }
      return {
        availableRecipes: runnableRecipes,
        reachableItems,
        metastorageOnlyItemIds,
      };
    }, [
      settings.aic.unlockedFacilities,
      settings.aic.unlockedModes,
      settings.currentDomain,
      regionRawMaterials,
      structureVariantExcluded,
      metastorageSeedItems,
    ]);

  // Items the picker may show as targets: those reachable via the AIC-
  // and chain-filtered recipe set. Forced raws are in `reachableItems`
  // but typically carry `asTarget !== false` to exclude them; the
  // dialog further excludes already-targeted items.
  const targetableItems = useMemo(
    () =>
      items.filter(
        (item) => reachableItems.has(item.id) && item.asTarget !== false,
      ),
    [reachableItems],
  );

  // Per-region target-gate map (item → the AIC techs that gate it in the
  // current factory region). Memoized on `currentDomain` ALONE: it's
  // derived from the maximal-unlock reference set, so live research/roster
  // changes never invalidate it — only a region switch does. Replaces the
  // former build-time generated `targetGates` map.
  const regionTargetGates = useMemo(
    () => computeTargetGatesForRegion(settings.currentDomain),
    [settings.currentDomain],
  );

  // Items the picker shows GREYED: producible in the current factory
  // region but currently unreachable purely because an AIC plan is
  // unresearched (`regionTargetGates` + a resolvable action against live
  // state). Items that can't be made in this region at all have no gate
  // action here and stay hidden. Clicking one navigates Settings to the
  // earliest blocking plan region (see `handleLockedTargetClick`).
  const lockedTargetItems = useMemo(() => {
    const out: Item[] = [];
    for (const item of items) {
      if (item.asTarget === false) continue;
      if (reachableItems.has(item.id)) continue;
      const gate = regionTargetGates.get(item.id);
      if (!gate) continue;
      if (
        resolveGateAction(
          gate,
          settings.currentDomain,
          settings.activeDomains,
          settings.aic.researched,
        )
      ) {
        out.push(item);
      }
    }
    return out;
  }, [
    regionTargetGates,
    reachableItems,
    settings.currentDomain,
    settings.activeDomains,
    settings.aic.researched,
  ]);

  // Aggregated per-facility cap = sum over currently-active domains of
  // each (facility, domain) effective cap, PLUS one slot per enabled
  // structure with `solver.role === "instance"`. Threaded into the LP
  // and the Phase 5 MIP via `useProductionPlan` →
  // `calculateProductionPlan({ facilityCaps })`. Facilities without
  // entries are uncapped (omitted from the map entirely — the LP and
  // packer both treat absence as no constraint).
  //
  // Structures contribute exactly +1 per enabled `instance`; today the
  // sole `instance` is `LIQUID_CLEAN_GATE_1`, which has no AIC cap-raise nodes
  // and no base cap, so its `facilityCaps` value comes entirely from
  // here.
  //
  // NOTE: summing across active domains (rather than restricting to the
  // user's `currentDomain`) is preserved pending empirical clarification
  // of whether cap-raise techs are per-region or account-wide. Today
  // only `xiranite_oven_1` is capped, and it's locked to `domain_2`,
  // so the question is moot. Revisit if/when a second-region-capped
  // facility surfaces and we can observe in-game behaviour.
  const facilityCaps = useMemo(() => {
    const out = new Map<FacilityId, number>();
    for (const [facilityId, perDomain] of settings.aic.effectiveCaps) {
      let total = 0;
      let anyActive = false;
      for (const [domainId, cap] of perDomain) {
        if (settings.activeDomains.has(domainId)) {
          total += cap;
          anyActive = true;
        }
      }
      if (anyActive) out.set(facilityId, total);
    }
    for (const [domainId, list] of regionStructures) {
      if (!settings.activeDomains.has(domainId)) continue;
      for (const s of list) {
        if (s.solver.role !== "instance") continue;
        if (!settings.structures.enabled.has(structureKey(domainId, s.id))) {
          continue;
        }
        out.set(
          s.solver.facilityId,
          (out.get(s.solver.facilityId) ?? 0) + 1,
        );
      }
    }
    return out;
  }, [
    settings.aic.effectiveCaps,
    settings.activeDomains,
    settings.structures.enabled,
  ]);

  // Aggregated per-(raw item) cap for the current factory region, in
  // items/min. Single-region lookup at `currentDomain` (raws are
  // physically tied to per-region resource POIs / pump deployability,
  // so summing across active domains is semantically wrong — caps
  // never aggregate across regions).
  //
  // Seeded from `defaultRawCapsByDomain` (the region's max mining
  // output at max Regional Development Level, generated by
  // `extract:raw-caps`); a user override always wins per item. Items
  // with neither a default nor an override (Burdo-Muck, liquids) stay
  // unconstrained (LP infinite-supply, no over-cap warning possible).
  // Precedence + sanity-filter semantics live in `buildRawMaterialCaps`.
  // Threaded into `useProductionPlan` → `calculateProductionPlan`
  // ({ rawCaps }) and into the warning surface.
  const rawMaterialCaps = useMemo(
    () =>
      buildRawMaterialCaps(
        defaultRawCapsByDomain.get(settings.currentDomain),
        settings.rawLimits.overrides,
        settings.currentDomain,
      ),
    [settings.rawLimits.overrides, settings.currentDomain],
  );

  const {
    targets,
    dialogOpen,
    activeTab,
    plan,
    tableData,
    stats,
    error,
    warnings,
    capIssueCount,
    rawMaterialCapMap,
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
    setDialogOpen,
    setActiveTab,
    ceilMode,
    setCeilMode,
    binFusion,
    setBinFusion,
    powerSustain,
    setPowerSustain,
    machinesPerVaporizer,
    setMachinesPerVaporizer,
    powerTargets,
    powerSustainUnavailable,
    handleSavePlan,
    handleOpenPlan,
    isLoading,
    pinnedItemIds,
    ineffectivePins,
  } = useProductionPlan(
    availableRecipes,
    regionRawMaterials,
    facilityCaps,
    rawMaterialCaps,
    metastorageRoutes,
  );

  // Content-keyed (same pattern as `metastorageRouteSig` above): lock
  // toggles produce a new `targets` identity without changing any
  // itemId:rate pair — a fresh Map here would ripple through the tree
  // mappers (and ELK layout) for no visual difference.
  const targetRatesSig = targets
    .map((t) => `${t.itemId}:${t.rate}`)
    .join(",");
  const targetRates = useMemo(
    () => new Map(targets.map((t) => [t.itemId as ItemId, t.rate])),
    // `targetRatesSig` fully captures the map's content (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetRatesSig],
  );

  // Optimizer UI signals derived from the single search-state object:
  // per-button spinner (max index / fit), plus mutual exclusion (all
  // optimizer affordances disable while any search runs).
  const maximizingIndex =
    optimizeState?.kind === "max" ? optimizeState.index : null;
  const optimizerBusy = optimizeState !== null;
  const fitRunning = optimizeState?.kind === "fit";
  // Zero-arg wrapper: the manual pill scales ALL unlocked targets (no
  // excluded index — that parameter is for auto-fit / priority-Max).
  const handleFitPillClick = useCallback(() => {
    void handleFitToLimits();
  }, [handleFitToLimits]);

  const isPortrait = usePortrait();

  // Portrait-only top-level view switch (bottom nav). Always lands on
  // Plan — the targets grid is what drives everything, so it's the
  // entry point even for shared/saved plan links (the ticker at the
  // bottom still surfaces live totals; results are one tap away).
  // Deliberately NOT auto-switched after adding targets.
  const [mobileView, setMobileView] = useState<MobileView>("plan");

  // Settings-sheet visibility lives here (not in AppHeader) so both the
  // header gear and the left-rail Options card can open it. Stable
  // callback: LeftPanel / PortraitDrawer are memoised.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);

  // Settings-sheet focus request, set when a greyed (locked) target is
  // clicked in the Add-Target picker: resolves the earliest blocking plan
  // region for the current factory region, closes the picker, and opens
  // Settings on that region with the required tech nodes flagged for
  // flashing. The `nonce` re-fires the navigation/flash even when the
  // same target is clicked twice.
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocus | null>(
    null,
  );
  // Monotonic counter for the focus `nonce` — guarantees a fresh value
  // per click (Date.now() could collide within the same millisecond) so
  // the navigation/flash effects always re-fire.
  const focusNonceRef = useRef(0);
  const handleLockedTargetClick = useCallback(
    (itemId: ItemId) => {
      const gate = regionTargetGates.get(itemId);
      if (!gate) return;
      const action = resolveGateAction(
        gate,
        settings.currentDomain,
        settings.activeDomains,
        settings.aic.researched,
      );
      if (!action) return;
      setSettingsFocus({
        nonce: ++focusNonceRef.current,
        domainId: action.domainId,
        techIds: action.techIds,
      });
      setDialogOpen(false);
      setSettingsOpen(true);
    },
    [
      regionTargetGates,
      settings.currentDomain,
      settings.activeDomains,
      settings.aic.researched,
      setDialogOpen,
    ],
  );

  // Clear the focus once the flash has played, so re-opening or
  // re-visiting the region doesn't replay it. A fresh locked-item click
  // sets a new focus (new nonce) and re-triggers.
  useEffect(() => {
    if (!settingsFocus) return;
    const timer = setTimeout(() => setSettingsFocus(null), 2500);
    return () => clearTimeout(timer);
  }, [settingsFocus]);

  const handleLanguageChange = (lang: string) => {
    i18n.changeLanguage(lang);
  };

  return (
    <div className="h-screen flex flex-col p-4 pb-0 gap-4 overflow-x-hidden [@media(orientation:portrait)]:pb-[max(1rem,env(safe-area-inset-bottom))]">
      <AppHeader
        onLanguageChange={handleLanguageChange}
        onSavePlan={handleSavePlan}
        onOpenPlan={handleOpenPlan}
        onOpenSettings={handleOpenSettings}
      />

      <div className="flex-1 flex gap-4 min-h-0">
        <div className={isPortrait ? "hidden" : "contents"}>
              <LeftPanel
                targets={targets}
                items={items}
                maxEnabledByTarget={maxEnabledByTarget}
                ceilMode={ceilMode}
                onCeilModeChange={setCeilMode}
                autoFit={autoFit}
                onAutoFitChange={setAutoFit}
                powerSustain={powerSustain}
                onPowerSustainChange={setPowerSustain}
                machinesPerVaporizer={machinesPerVaporizer}
                onMachinesPerVaporizerChange={setMachinesPerVaporizer}
                powerTargets={powerTargets}
                powerSustainUnavailable={powerSustainUnavailable}
                onOpenSettings={handleOpenSettings}
                onTargetChange={handleTargetChange}
                onTargetRemove={handleTargetRemove}
                onTargetLockToggle={handleTargetLockToggle}
                onMaximizeTarget={handleMaximizeTarget}
                maximizingIndex={maximizingIndex}
                optimizerBusy={optimizerBusy}
                maxedIndices={maxedIndices}
                showFitPill={showFitPill}
                fitRunning={fitRunning}
                onFitToLimits={handleFitPillClick}
                onAddClick={handleAddClick}
              />
        </div>

        {/* Portrait "Plan" tab panel — the discoverable home for the
            plan console (it used to hide inside the drawer). Second
            simultaneous mount of the PlanPanel next to LeftPanel's
            (the orientation/tab swap is CSS-only), same dual-host
            pattern PortraitDrawer used before. */}
        <div
          className={
            isPortrait && mobileView === "plan"
              ? "flex-1 min-w-0 flex flex-col overflow-y-auto"
              : "hidden"
          }
        >
          <PlanPanel
            targets={targets}
            items={items}
            maxEnabledByTarget={maxEnabledByTarget}
            ceilMode={ceilMode}
            onCeilModeChange={setCeilMode}
            autoFit={autoFit}
            onAutoFitChange={setAutoFit}
            powerSustain={powerSustain}
            onPowerSustainChange={setPowerSustain}
            machinesPerVaporizer={machinesPerVaporizer}
            onMachinesPerVaporizerChange={setMachinesPerVaporizer}
            powerTargets={powerTargets}
            powerSustainUnavailable={powerSustainUnavailable}
            onOpenSettings={handleOpenSettings}
            onTargetChange={handleTargetChange}
            onTargetRemove={handleTargetRemove}
            onTargetLockToggle={handleTargetLockToggle}
            onMaximizeTarget={handleMaximizeTarget}
            maximizingIndex={maximizingIndex}
            optimizerBusy={optimizerBusy}
            maxedIndices={maxedIndices}
            showFitPill={showFitPill}
            fitRunning={fitRunning}
            onFitToLimits={handleFitPillClick}
            onAddClick={handleAddClick}
          />
        </div>

        <div
          className={
            isPortrait && mobileView === "plan" ? "hidden" : "contents"
          }
        >
          <ProductionViewTabs
            plan={plan}
            tableData={tableData}
            items={items}
            recipes={availableRecipes}
            facilities={facilities}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRecipeChange={handleRecipeChange}
            onRecipePinReset={handleRecipePinReset}
            onToggleRawMaterial={handleToggleRawMaterial}
            pinnedItemIds={pinnedItemIds}
            ineffectivePins={ineffectivePins}
            targetRates={targetRates}
            ceilMode={ceilMode}
            binFusion={binFusion}
            onBinFusionChange={setBinFusion}
            loading={isLoading}
          />
        </div>
      </div>

      <div className={isPortrait ? "hidden" : "contents"}>
        <BottomDock
          stats={stats}
          facilities={facilities}
          items={items}
          error={error}
          warnings={warnings}
          capIssueCount={capIssueCount}
          ceilMode={ceilMode}
          rawMaterialCapMap={rawMaterialCapMap}
        />
      </div>

      {/* Portrait: stats ticker/drawer on BOTH nav tabs (live feedback
          while adding targets), then the bottom nav itself. */}
      <div className={isPortrait ? "contents" : "hidden"}>
        <PortraitDrawer
          items={items}
          facilities={facilities}
          stats={stats}
          error={error}
          warnings={warnings}
          capIssueCount={capIssueCount}
          rawMaterialCapMap={rawMaterialCapMap}
          ceilMode={ceilMode}
        />
        <MobileNav view={mobileView} onViewChange={setMobileView} />
      </div>

      <AddTargetDialogGrid
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        items={targetableItems}
        lockedItems={lockedTargetItems}
        metastorageOnlyIds={metastorageOnlyItemIds}
        existingTargetIds={targets.map((t) => t.itemId)}
        regionRawMaterials={regionRawMaterials}
        producibleRawTargetIds={producibleRawTargetIds}
        onBatchAddTargets={handleBatchAddTargets}
        onLockedItemClick={handleLockedTargetClick}
      />

      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        focus={settingsFocus}
      />

      <AppFooter />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider defaultTheme="light" storageKey={namespaceStorageKey("vite-ui-theme")}>
      <DomainSettingsProvider>
        <TooltipProvider>
          <AppContent />
          <ThemedToaster />
        </TooltipProvider>
      </DomainSettingsProvider>
    </ThemeProvider>
  );
}
