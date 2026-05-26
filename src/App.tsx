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
import { bootstrapFacilities, forcedRawMaterials } from "./data";
import type { FacilityId, ItemId } from "./types";

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
  //      inputs are reachable from `forcedRawMaterials` via the AIC-
  //      filtered set, with one exception: recipes on `bootstrap
  //      Facilities` (e.g. Seed-Picking Unit) are unconditionally
  //      runnable when the facility is unlocked. This handles the
  //      planter↔seedcollector cycle that has no entry from forced
  //      raws — in-game the player seeds the cycle externally. See
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
    const { runnableRecipes, reachableItems } = computeRecipeReachability(
      aicFiltered,
      forcedRawMaterials,
      bootstrapFacilities,
    );
    return { availableRecipes: runnableRecipes, reachableItems };
  }, [
    settings.aic.unlockedFacilities,
    settings.aic.unlockedModes,
    settings.currentDomain,
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
  // each (facility, domain) effective cap. Threaded into the Phase 5
  // MIP via `useProductionPlan` → `calculateProductionPlan({ facilityCaps })`.
  // Facilities without entries in `effectiveCaps` are uncapped (omitted
  // from the map entirely — the packer treats absence as no constraint).
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
    return out;
  }, [settings.aic.effectiveCaps, settings.activeDomains]);

  const {
    targets,
    dialogOpen,
    activeTab,
    plan,
    tableData,
    stats,
    error,
    warnings,
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
  } = useProductionPlan(availableRecipes, facilityCaps);

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
