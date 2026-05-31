import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import { items, recipes, facilities } from "./data";
import { useProductionPlan } from "./hooks/useProductionPlan";
import { usePortrait } from "./hooks/usePortrait";
import AppHeader from "./components/layout/AppHeader";
import LeftPanel from "./components/panels/LeftPanel";
import PortraitDrawer from "./components/panels/PortraitDrawer";
import ProductionViewTabs from "./components/production/ProductionViewTabs";
import AddTargetDialogGrid from "./components/panels/AddTargetDialogGrid";
import AppFooter from "./components/layout/AppFooter";
import { ThemeProvider, useTheme } from "./components/ui/theme-provider";
import { DomainSettingsProvider } from "./contexts/DomainSettingsProvider";
import { useDomainSettingsContext } from "./contexts/domain-settings-context";
import {
  computeAvailableFacilities,
  computeRecipeAvailability,
} from "./lib/aic-research-helpers";
import { computeRecipeReachability } from "./lib/recipe-reachability";
import {
  bootstrapFacilities,
  facilityRecipeVariants,
  rawAvailabilityByDomain,
  regionStructures,
} from "./data";
import { parseRawLimitKey } from "./lib/raw-limits-helpers";
import { structureKey } from "./lib/settings-helpers";
import type { FacilityId, ItemId, RecipeId } from "./types";

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

  // Recipe-variant exclusions driven by `regionStructures` × the user's
  // enabled-structures set. For each entry in `facilityRecipeVariants`,
  // pick the wrong-side variant (or both if the facility has no enabled
  // `instance` structures in any active domain) and add it to the
  // exclusion set; the recipe filter below drops them from
  // `availableRecipes`.
  //
  // Why this lives at the App layer (alongside the existing AIC filter):
  // the calc / graph-builder / LP all operate on whatever recipe set
  // they're given. Filtering here keeps the algorithm code decoupled
  // from settings semantics and mirrors how `computeRecipeAvailability`
  // already gates on AIC unlocks. The filter is sound regardless of
  // whether the facility itself is region-available — the AIC /
  // reachability passes will drop the recipes anyway when its facility
  // isn't reachable, so an excess entry here is harmless.
  const structureVariantExcluded = useMemo(() => {
    const excluded = new Set<RecipeId>();
    for (const [facilityId, variants] of facilityRecipeVariants) {
      let hasInstance = false;
      let isToggled = false;
      for (const [domainId, list] of regionStructures) {
        if (!settings.activeDomains.has(domainId)) continue;
        for (const s of list) {
          if (s.solver.facilityId !== facilityId) continue;
          if (!settings.structures.enabled.has(structureKey(domainId, s.id))) {
            continue;
          }
          if (s.solver.role === "instance") hasInstance = true;
          else if (s.solver.role === "recipeToggle") isToggled = true;
        }
      }
      if (!hasInstance) {
        // No physical buildings → neither variant should be selectable.
        // (A `recipeToggle` without any `instance` is degenerate; the
        // settings UI cascade prevents enabling the outlet without all
        // inlets, but we defend against it here too.)
        excluded.add(variants.default);
        excluded.add(variants.toggled);
      } else {
        excluded.add(isToggled ? variants.default : variants.toggled);
      }
    }
    return excluded;
  }, [settings.activeDomains, settings.structures.enabled]);

  const { availableRecipes, reachableItems } = useMemo(() => {
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
    // Apply the structure-variant filter BEFORE reachability so the
    // inactive variant can't leak into the reachable set or the LP.
    const variantFiltered = aicFiltered.filter(
      (r) => !structureVariantExcluded.has(r.id),
    );
    const { runnableRecipes, reachableItems } = computeRecipeReachability(
      variantFiltered,
      regionRawMaterials,
      bootstrapFacilities,
    );
    return { availableRecipes: runnableRecipes, reachableItems };
  }, [
    settings.aic.unlockedFacilities,
    settings.aic.unlockedModes,
    settings.currentDomain,
    regionRawMaterials,
    structureVariantExcluded,
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

  // Aggregated per-facility cap = sum over currently-active domains of
  // each (facility, domain) effective cap, PLUS one slot per enabled
  // structure with `solver.role === "instance"`. Threaded into the LP
  // and the Phase 5 MIP via `useProductionPlan` →
  // `calculateProductionPlan({ facilityCaps })`. Facilities without
  // entries are uncapped (omitted from the map entirely — the LP and
  // packer both treat absence as no constraint).
  //
  // Structures contribute exactly +1 per enabled `instance`; today the
  // sole `instance` is `SEWAGE_INLET`, which has no AIC cap-raise nodes
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
  // **Defense-in-depth sanity filter**: drop entries with non-finite
  // or negative values. The hook setter + loader already reject these,
  // but a hand-edited localStorage entry or a future programmatic
  // setter could sneak past — this final gate keeps invalid values
  // out of the LP / warning surface entirely.
  //
  // **"No entry = no limit"**: items the user hasn't capped for the
  // current region don't appear here. The calc treats them as
  // unconstrained (LP infinite-supply, no over-cap warning possible).
  // Threaded into `useProductionPlan` → `calculateProductionPlan`
  // ({ rawCaps }) and into the warning surface.
  const rawMaterialCaps = useMemo(() => {
    const out = new Map<ItemId, number>();
    for (const [key, value] of settings.rawLimits.overrides) {
      if (!Number.isFinite(value) || value < 0) continue;
      const parsed = parseRawLimitKey(key);
      if (!parsed) continue;
      if (parsed.domainId !== settings.currentDomain) continue;
      out.set(parsed.itemId, value);
    }
    return out;
  }, [settings.rawLimits.overrides, settings.currentDomain]);

  const {
    targets,
    dialogOpen,
    activeTab,
    plan,
    tableData,
    stats,
    error,
    warnings,
    rawMaterialOverCapMap,
    handleTargetChange,
    handleTargetRemove,
    handleBatchAddTargets,
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
  );

  const targetRates = useMemo(
    () => new Map(targets.map((t) => [t.itemId as ItemId, t.rate])),
    [targets],
  );

  const isPortrait = usePortrait();

  const handleLanguageChange = (lang: string) => {
    i18n.changeLanguage(lang);
  };

  return (
    <div className="h-screen flex flex-col p-4 pb-0 gap-4 overflow-x-hidden [@media(orientation:portrait)]:pb-4">
      <AppHeader onLanguageChange={handleLanguageChange} onSavePlan={handleSavePlan} onOpenPlan={handleOpenPlan} />

      <div className="flex-1 flex gap-4 min-h-0">
        <div className={isPortrait ? "hidden" : "contents"}>
              <LeftPanel
                targets={targets}
                items={items}
                facilities={facilities}
                totalPowerConsumption={stats.totalPowerConsumption}
                productionSteps={stats.uniqueProductionSteps}
                rawMaterialRequirements={stats.rawMaterialRequirements}
                facilityRequirements={stats.facilityRequirements}
                totalPickupPoints={stats.totalPickupPoints}
                rawMaterialPickupPoints={stats.rawMaterialPickupPoints}
                facilityOverCapMap={stats.facilityOverCapMap}
                rawMaterialOverCapMap={rawMaterialOverCapMap}
                error={error}
                ceilMode={ceilMode}
                onTargetChange={handleTargetChange}
                onTargetRemove={handleTargetRemove}
                onAddClick={handleAddClick}
              />
        </div>

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
          onCeilModeChange={setCeilMode}
          binFusion={binFusion}
          onBinFusionChange={setBinFusion}
          warnings={warnings}
          loading={isLoading}
        />
      </div>

      <div className={isPortrait ? "contents" : "hidden"}>
        <PortraitDrawer
          targets={targets}
          items={items}
          facilities={facilities}
          totalPowerConsumption={stats.totalPowerConsumption}
          productionSteps={stats.uniqueProductionSteps}
          rawMaterialRequirements={stats.rawMaterialRequirements}
          facilityRequirements={stats.facilityRequirements}
          totalPickupPoints={stats.totalPickupPoints}
          rawMaterialPickupPoints={stats.rawMaterialPickupPoints}
          facilityOverCapMap={stats.facilityOverCapMap}
          rawMaterialOverCapMap={rawMaterialOverCapMap}
          error={error}
          ceilMode={ceilMode}
          onTargetChange={handleTargetChange}
          onTargetRemove={handleTargetRemove}
          onAddClick={handleAddClick}
        />
      </div>

      <AddTargetDialogGrid
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        items={targetableItems}
        existingTargetIds={targets.map((t) => t.itemId)}
        regionRawMaterials={regionRawMaterials}
        onBatchAddTargets={handleBatchAddTargets}
      />

      <AppFooter />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme">
      <DomainSettingsProvider>
        <TooltipProvider>
          <AppContent />
          <ThemedToaster />
        </TooltipProvider>
      </DomainSettingsProvider>
    </ThemeProvider>
  );
}
