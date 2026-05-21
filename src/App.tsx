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
import type { ItemId } from "./types";

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

export default function App() {
  const { i18n } = useTranslation("app");

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
  } = useProductionPlan();

  const targetRates = useMemo(
    () => new Map(targets.map((t) => [t.itemId as ItemId, t.rate])),
    [targets],
  );

  const isPortrait = usePortrait();

  const handleLanguageChange = (lang: string) => {
    i18n.changeLanguage(lang);
  };

  return (
    <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme">
      <TooltipProvider>
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
            items={items}
            existingTargetIds={targets.map((t) => t.itemId)}
            onBatchAddTargets={handleBatchAddTargets}
          />

          <AppFooter />
        </div>
        <ThemedToaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}
