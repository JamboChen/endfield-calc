import { memo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  error,
  onTargetChange,
  onTargetRemove,
  onAddClick,
}: LeftPanelProps) {
  const { t } = useTranslation("targets");
  return (
    <div className="w-[420px] flex flex-col gap-2.5 min-h-0">
      <Card className="shrink-0">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t("title")}</CardTitle>
            <div className="text-xs text-muted-foreground">
              {t("count", { current: targets.length, max: 12 })}
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
        facilities={facilities}
        items={items}
        error={error}
      />
    </div>
  );
});

export default LeftPanel;
