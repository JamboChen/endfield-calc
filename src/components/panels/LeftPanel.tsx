import { memo, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import TargetItemsGrid, { type ProductionTarget } from "./TargetItemsGrid";
import ProductionStats from "../production/ProductionStats";
import type { Facility, Item, ItemId } from "@/types";
import { useTranslation } from "react-i18next";

type LeftPanelProps = {
  targets: ProductionTarget[];
  items: Item[];
  facilities: Facility[];
  totalPowerConsumption: number;
  productionSteps: number;
  rawMaterialRequirements: Map<ItemId, number>;
  facilityRequirements: Map<string, number>;
  totalPickupPoints: number;
  rawMaterialPickupPoints: Map<ItemId, number>;
  error: string | null;
  onTargetChange: (index: number, rate: number) => void;
  onTargetRemove: (index: number) => void;
  onAddClick: () => void;
};

const LeftPanel = memo(function LeftPanel({
  targets,
  items,
  facilities,
  totalPowerConsumption,
  productionSteps,
  rawMaterialRequirements,
  facilityRequirements,
  totalPickupPoints,
  rawMaterialPickupPoints,
  error,
  onTargetChange,
  onTargetRemove,
  onAddClick,
}: LeftPanelProps) {
  const { t } = useTranslation("targets");
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className="flex flex-col shrink-0">
        <Button
          variant="outline"
          className="h-full w-8 rounded-r-none border-r-0 flex flex-col gap-1 py-4 px-0"
          onClick={() => setCollapsed(false)}
          aria-label="Expand panel"
        >
          <PanelLeftOpen className="h-4 w-4 shrink-0" />
        </Button>
      </div>
    );
  }

  return (
    <div className="w-[420px] flex flex-col gap-2.5 overflow-y-auto shrink-0 pb-2">
      <Card className="flex flex-col shrink-0">
        <CardHeader className="shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t("title")}</CardTitle>
            <div className="flex items-center gap-2">
              <div className="text-xs text-muted-foreground">
                {t("count", { current: targets.length, max: 12 })}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => setCollapsed(true)}
                aria-label="Collapse panel"
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <TargetItemsGrid
            targets={targets}
            items={items}
            onTargetChange={onTargetChange}
            onTargetRemove={onTargetRemove}
            onAddClick={onAddClick}
          />
        </CardContent>
      </Card>

      <ProductionStats
        totalPowerConsumption={totalPowerConsumption}
        productionSteps={productionSteps}
        rawMaterialRequirements={rawMaterialRequirements}
        facilityRequirements={facilityRequirements}
        totalPickupPoints={totalPickupPoints}
        rawMaterialPickupPoints={rawMaterialPickupPoints}
        facilities={facilities}
        items={items}
        error={error}
      />
    </div>
  );
});

export default LeftPanel;
