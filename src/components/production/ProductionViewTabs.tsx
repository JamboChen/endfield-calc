import { useTranslation } from "react-i18next";
import { useState } from "react";
import { BarChart3, Network } from "lucide-react";
import ProductionTable from "./ProductionTable";
import ProductionDependencyTree from "../flow/ProductionDependencyTree";
import SolverLoadingOverlay from "./SolverLoadingOverlay";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type {
  ItemId,
  RecipeId,
  Item,
  Recipe,
  Facility,
  ProductionDependencyGraph,
  VisualizationMode,
} from "@/types";
import type { ProductionTableData } from "@/hooks/useProductionTable";
import type { IneffectivePin } from "@/hooks/useProductionPlan";

interface ProductionViewTabsProps {
  plan: ProductionDependencyGraph | null;
  tableData: ProductionTableData;
  items: Item[];
  recipes: readonly Recipe[];
  facilities: Facility[];
  activeTab: "table" | "tree";
  onTabChange: (tab: "table" | "tree") => void;
  onRecipeChange: (itemId: ItemId, recipeId: RecipeId) => void;
  onRecipePinReset: (itemId: ItemId) => void;
  onToggleRawMaterial: (itemId: ItemId) => void;
  /** Items with a user-pinned recipe (effective or ineffective). Drives
   *  the reset-icon affordance in the recipe picker. */
  pinnedItemIds: ReadonlySet<ItemId>;
  /** Pinned recipes the LP chose not to run. Emitted as ghost rows at
   *  the end of the Production Table's row list. */
  ineffectivePins: IneffectivePin[];
  targetRates?: Map<ItemId, number>;
  /** Physical (ceiled) vs theoretical (fractional) display. The toggle
   *  itself lives in the left-rail Options card. */
  ceilMode: boolean;
  /** Bin-fusion toggle for Recipe View. Persisted in URL hash via the parent. */
  binFusion: boolean;
  onBinFusionChange: (value: boolean) => void;
  /** True while the solver is busy: either the HiGHS WASM module is
   *  still loading, or a calculation has been in flight long enough
   *  (>300ms) for the debounced loading overlay to engage. */
  loading: boolean;
}

export default function ProductionViewTabs({
  plan,
  tableData,
  items,
  recipes,
  facilities,
  activeTab,
  onTabChange,
  onRecipeChange,
  onRecipePinReset,
  onToggleRawMaterial,
  pinnedItemIds,
  ineffectivePins,
  targetRates,
  ceilMode,
  binFusion,
  onBinFusionChange,
  loading,
}: ProductionViewTabsProps) {
  const { t } = useTranslation("app");
  const [visualizationMode, setVisualizationMode] =
    useState<VisualizationMode>("merged");
  const [twoEndAlignment, setTwoEndAlignment] = useState(false);

  // The bin-fusion toggle only has visible effect when at least one bin
  // packs ≥2 demand recipes; for singleton / non-multi-formula plans the
  // ON / OFF outputs are identical, so we hide the control entirely.
  const hasGroupableRecipes =
    plan?.bins.some((bin) => bin.isGrouped) ?? false;

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

            {activeTab === "tree" && (
              <div className="flex items-center gap-2">
                <Switch
                  id="two-end-alignment"
                  checked={twoEndAlignment}
                  onCheckedChange={setTwoEndAlignment}
                />
                <Label
                  htmlFor="two-end-alignment"
                  className="text-xs whitespace-nowrap cursor-pointer hidden sm:block"
                >
                  {t("twoEndAlignment")}
                </Label>
              </div>
            )}

            {/* Bin-fusion toggle: shows only in Recipe View (merged) AND
                only when the current plan contains at least one grouped
                bin. Facility View (separated) is always bin-fused. */}
            {activeTab === "tree" &&
              visualizationMode === "merged" &&
              hasGroupableRecipes && (
                <div className="flex items-center gap-2">
                  <Switch
                    id="bin-fusion"
                    checked={binFusion}
                    onCheckedChange={onBinFusionChange}
                  />
                  <Label
                    htmlFor="bin-fusion"
                    title={t("binFusionTooltip")}
                    className="text-xs whitespace-nowrap cursor-pointer hidden sm:block"
                  >
                    {t("binFusion")}
                  </Label>
                </div>
              )}

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
        <CardContent className="relative flex-1 min-h-0 overflow-hidden p-0">
          {loading && <SolverLoadingOverlay />}
          <Tabs value={activeTab} className="h-full">
            {/* Solver warnings render in the stats surfaces (bottom
                dock / portrait card), not here — keeps the full view
                height for the table/tree. */}
            <TabsContent value="table" className="h-full m-0 p-4 pt-0">
              <div className="h-full overflow-auto">
                <ProductionTable
                  data={tableData.rows}
                  totals={tableData.totals}
                  items={items}
                  recipes={recipes}
                  onRecipeChange={onRecipeChange}
                  onRecipePinReset={onRecipePinReset}
                  onToggleRawMaterial={onToggleRawMaterial}
                  pinnedItemIds={pinnedItemIds}
                  ineffectivePins={ineffectivePins}
                  ceilMode={ceilMode}
                />
              </div>
            </TabsContent>
            <TabsContent value="tree" className="h-full m-0">
              <div className="h-full flex flex-col">
                <div className="flex-1 min-h-0">
                  <ProductionDependencyTree
                    plan={plan}
                    items={items}
                    recipes={recipes}
                    facilities={facilities}
                    visualizationMode={visualizationMode}
                    targetRates={targetRates}
                    twoEndAlignment={twoEndAlignment}
                    ceilMode={ceilMode}
                    binFusion={binFusion}
                  />
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
