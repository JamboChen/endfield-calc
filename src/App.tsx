import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { TooltipProvider } from "@/components/ui/tooltip";

import { items, facilities } from "./data";
import { useProductionPlan } from "./hooks/useProductionPlan";
import AppHeader from "./components/layout/AppHeader";
import LeftPanel from "./components/panels/LeftPanel";
import ProductionViewTabs from "./components/production/ProductionViewTabs";
import AddTargetDialogGrid from "./components/panels/AddTargetDialogGrid";
import AppFooter from "./components/layout/AppFooter";
import { ThemeProvider } from "./components/ui/theme-provider";
import type { ItemId } from "./types";

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
    handleTargetChange,
    handleTargetRemove,
    handleAddTarget,
    handleToggleRawMaterial,
    handleRecipeChange,
    handleAddClick,
    setDialogOpen,
    setActiveTab,
    ceilMode,
    setCeilMode,
  } = useProductionPlan();

  const targetRates = useMemo(
    () => new Map(targets.map((t) => [t.itemId as ItemId, t.rate])),
    [targets],
  );

  const handleLanguageChange = (lang: string) => {
    i18n.changeLanguage(lang);
  };

  return (
    <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme">
      <TooltipProvider>
        <div className="h-screen flex flex-col p-4 pb-0 gap-4">
          <AppHeader onLanguageChange={handleLanguageChange} />

          <div className="flex-1 flex gap-4 min-h-0">
            <LeftPanel
              targets={targets}
              items={items}
              facilities={facilities}
              totalPowerConsumption={stats.totalPowerConsumption}
              productionSteps={stats.uniqueProductionSteps}
              rawMaterialRequirements={stats.rawMaterialRequirements}
              facilityRequirements={stats.facilityRequirements}
              error={error}
              onTargetChange={handleTargetChange}
              onTargetRemove={handleTargetRemove}
              onAddClick={handleAddClick}
            />

            <ProductionViewTabs
              plan={plan}
              tableData={tableData}
              items={items}
              facilities={facilities}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onRecipeChange={handleRecipeChange}
              onToggleRawMaterial={handleToggleRawMaterial}
              targetRates={targetRates}
              ceilMode={ceilMode}
              onCeilModeChange={setCeilMode}
            />
          </div>

          <AddTargetDialogGrid
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            items={items}
            existingTargetIds={targets.map((t) => t.itemId)}
            onAddTarget={handleAddTarget}
          />

          <AppFooter />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}
