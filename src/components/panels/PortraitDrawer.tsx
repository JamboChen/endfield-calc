import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp, Zap, Package, Target } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import TargetItemsGrid, { type ProductionTarget } from "./TargetItemsGrid";
import ProductionStats from "../production/ProductionStats";
import type { Facility, Item, ItemId } from "@/types";

type PortraitDrawerProps = {
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

export default function PortraitDrawer({
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
}: PortraitDrawerProps) {
  const { t: tTargets } = useTranslation("targets");
  const { t: tStats } = useTranslation("stats");
  const [open, setOpen] = useState(false);

  const handleAddClick = () => {
    setOpen(false);
    onAddClick();
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          className="w-full flex items-center justify-between px-4 py-2.5 bg-card border border-border rounded-lg shadow-sm hover:bg-accent/50 transition-colors"
          aria-label={tTargets("title")}
        >
          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Target className="h-3.5 w-3.5" />
              <span className="font-medium text-foreground">
                {targets.length}
              </span>
              <span>{tTargets("title")}</span>
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Zap className="h-3.5 w-3.5" />
              <span className="font-medium text-foreground font-mono">
                {totalPowerConsumption.toFixed(1)}
              </span>
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Package className="h-3.5 w-3.5" />
              <span className="font-medium text-foreground">
                {rawMaterialRequirements.size}
              </span>
              <span>{tStats("rawMaterials")}</span>
            </span>
          </div>
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        </button>
      </SheetTrigger>

      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="h-[80svh] flex flex-col rounded-t-xl px-4 pb-0 data-[state=closed]:duration-150 data-[state=open]:duration-200"
      >
        <SheetHeader className="shrink-0 pb-2">
          <SheetTitle>{tTargets("title")}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pb-4">
          <TargetItemsGrid
            targets={targets}
            items={items}
            onTargetChange={onTargetChange}
            onTargetRemove={onTargetRemove}
            onAddClick={handleAddClick}
          />

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
      </SheetContent>
    </Sheet>
  );
}
