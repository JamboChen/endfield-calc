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
import { computeRecipeAvailability } from "./lib/aic-research-helpers";
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

  // AIC-filtered recipe set: drops recipes whose host facility is locked
  // or whose mode is gated by an unresearched modeUnlock tech. Re-derived
  // on every research/activation change; the auto-prune effect inside
  // `useProductionPlan` cleans up targets/overrides/raws that became
  // unreachable as a result.
  const availableRecipes = useMemo(
    () =>
      computeRecipeAvailability(
        recipes,
        settings.aic.unlockedFacilities,
        settings.aic.unlockedModes,
      ).availableRecipes,
    [settings.aic.unlockedFacilities, settings.aic.unlockedModes],
  );

  // Items the picker may show as targets: those produced by ANY recipe
  // in `availableRecipes`. Raws (no producer) and `asTarget: false`
  // items are filtered out here; the dialog further excludes
  // already-targeted items.
  const targetableItems = useMemo(() => {
    const reachable = new Set<ItemId>();
    for (const r of availableRecipes) {
      for (const o of r.outputs) reachable.add(o.itemId);
    }
    return items.filter(
      (item) => reachable.has(item.id) && item.asTarget !== false,
    );
  }, [availableRecipes]);

  // Aggregated per-facility cap = sum over currently-active domains of
  // each (facility, domain) effective cap. Threaded into the Phase 5
  // MIP via `useProductionPlan` → `calculateProductionPlan({ facilityCaps })`.
  // Facilities without entries in `effectiveCaps` are uncapped (omitted
  // from the map entirely — the packer treats absence as no constraint).
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
          recipes={recipes}
          facilities={facilities}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onRecipeChange={handleRecipeChange}
          onToggleRawMaterial={handleToggleRawMaterial}
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
