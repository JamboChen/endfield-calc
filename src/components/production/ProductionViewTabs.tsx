import { useTranslation } from "react-i18next";
import { useState } from "react";
import { BarChart3, Network } from "lucide-react";
import ProductionTable from "./ProductionTable";
import ProductionDependencyTree from "../flow/ProductionDependencyTree";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type {
  ItemId,
  RecipeId,
  Item,
  Facility,
  ProductionDependencyGraph,
  VisualizationMode,
} from "@/types";
import type { ProductionLineData } from "./ProductionTable";

interface ProductionViewTabsProps {
  plan: ProductionDependencyGraph | null;
  tableData: ProductionLineData[];
  items: Item[];
  facilities: Facility[];
  activeTab: "table" | "tree";
  onTabChange: (tab: "table" | "tree") => void;
  onRecipeChange: (itemId: ItemId, recipeId: RecipeId) => void;
  onToggleRawMaterial: (itemId: ItemId) => void;
  targetRates?: Map<ItemId, number>;
  ceilMode: boolean;
  onCeilModeChange: (value: boolean) => void;
}

export default function ProductionViewTabs({
  plan,
  tableData,
  items,
  facilities,
  activeTab,
  onTabChange,
  onRecipeChange,
  onToggleRawMaterial,
  targetRates,
  ceilMode,
  onCeilModeChange,
}: ProductionViewTabsProps) {
  const { t } = useTranslation("app");
  const [visualizationMode, setVisualizationMode] =
    useState<VisualizationMode>("merged");

  return (
    <div className="flex-1 min-w-0">
      <Card className="h-full flex flex-col">
        <CardHeader className="shrink-0">
          <div className="flex items-center justify-between gap-4">
            <Tabs
              value={activeTab}
              onValueChange={(val) => onTabChange(val as "table" | "tree")}
              className="flex-1"
            >
              <TabsList className="grid w-full max-w-md grid-cols-2">
                <TabsTrigger value="table" className="gap-2">
                  <BarChart3 className="h-4 w-4 shrink-0" />
                  <span className="hidden sm:inline">{t("tabs.table")}</span>
                </TabsTrigger>
                <TabsTrigger value="tree" className="gap-2">
                  <Network className="h-4 w-4 shrink-0" />
                  <span className="hidden sm:inline">{t("tabs.tree")}</span>
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="flex items-center gap-2">
              <Switch
                id="ceil-mode"
                checked={ceilMode}
                onCheckedChange={onCeilModeChange}
              />
              <Label
                htmlFor="ceil-mode"
                className="text-xs whitespace-nowrap cursor-pointer hidden sm:block"
              >
                {t("ceilMode")}
              </Label>
            </div>

            {activeTab === "tree" && (
              <ToggleGroup
                type="single"
                value={visualizationMode}
                onValueChange={(value) => {
                  if (value) setVisualizationMode(value as VisualizationMode);
                }}
              >
                <ToggleGroupItem value="merged" aria-label="Merged view">
                  <span className="text-xs hidden sm:inline">
                    {t("tabs.merged")}
                  </span>
                  <Network className="h-3.5 w-3.5 sm:hidden" />
                </ToggleGroupItem>
                <ToggleGroupItem value="separated" aria-label="Separated view">
                  <span className="text-xs hidden sm:inline">
                    {t("tabs.separated")}
                  </span>
                  <BarChart3 className="h-3.5 w-3.5 sm:hidden" />
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 overflow-hidden p-0">
          <Tabs value={activeTab} className="h-full">
            <TabsContent value="table" className="h-full m-0 p-4 pt-0">
              <div className="h-full overflow-auto">
                <ProductionTable
                  data={tableData}
                  items={items}
                  facilities={facilities}
                  onRecipeChange={onRecipeChange}
                  onToggleRawMaterial={onToggleRawMaterial}
                  ceilMode={ceilMode}
                />
              </div>
            </TabsContent>
            <TabsContent value="tree" className="h-full m-0">
              <ProductionDependencyTree
                plan={plan}
                items={items}
                facilities={facilities}
                visualizationMode={visualizationMode}
                targetRates={targetRates}
                ceilMode={ceilMode}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
