import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import TargetItemsGrid, { type ProductionTarget } from "./TargetItemsGrid";
import OptionsCard from "./OptionsCard";
import StatsTicker from "./StatsTicker";
import ProductionStats from "../production/ProductionStats";
import type { Facility, Item, ItemId } from "@/types";
import type { ProductionStats as ProductionStatsData } from "@/hooks/useProductionStats";

type PortraitDrawerProps = {
  targets: ProductionTarget[];
  items: Item[];
  facilities: Facility[];
  stats: ProductionStatsData;
  error: string | null;
  warnings: string[];
  rawMaterialOverCapMap: ReadonlyMap<ItemId, { used: number; cap: number }>;
  maxEnabledByTarget: ReadonlyMap<ItemId, boolean>;
  ceilMode?: boolean;
  onCeilModeChange: (value: boolean) => void;
  onOpenSettings: () => void;
  onTargetChange: (index: number, rate: number) => void;
  onTargetRemove: (index: number) => void;
  onTargetLockToggle: (index: number) => void;
  onAddClick: () => void;
};

/**
 * Portrait-mode bottom drawer. The trigger is the same `StatsTicker`
 * strip the landscape dock uses (one visual language for the plan
 * summary); tapping it opens an 80svh sheet with the targets grid, the
 * Options card and the full stats card.
 */
export default function PortraitDrawer({
  targets,
  items,
  facilities,
  stats,
  error,
  warnings,
  rawMaterialOverCapMap,
  maxEnabledByTarget,
  ceilMode = false,
  onCeilModeChange,
  onOpenSettings,
  onTargetChange,
  onTargetRemove,
  onTargetLockToggle,
  onAddClick,
}: PortraitDrawerProps) {
  const { t: tTargets } = useTranslation("targets");
  const [open, setOpen] = useState(false);

  const handleAddClick = () => {
    setOpen(false);
    onAddClick();
  };

  // Close the drawer before opening the Settings sheet — stacking two
  // Radix sheets (bottom drawer + right settings) traps focus and looks
  // broken on small screens.
  const handleOpenSettings = () => {
    setOpen(false);
    onOpenSettings();
  };

  const issueCount = warnings.length + (error ? 1 : 0);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* `asChild` restores Radix trigger semantics (aria-controls,
          focus return on close); the ticker spreads the injected props
          onto its root button. */}
      <SheetTrigger asChild>
        <StatsTicker
          totalPowerConsumption={stats.totalPowerConsumption}
          totalBuildings={stats.totalBuildings}
          totalTiles={stats.totalTiles}
          depotPickupPoints={stats.depotPickupPoints}
          issueCount={issueCount}
          ceilMode={ceilMode}
          error={error}
          expanded={open}
          className="bg-card border border-border rounded-lg shadow-sm"
        />
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
            maxEnabledByTarget={maxEnabledByTarget}
            onTargetChange={onTargetChange}
            onTargetRemove={onTargetRemove}
            onTargetLockToggle={onTargetLockToggle}
            onAddClick={handleAddClick}
          />

          <OptionsCard
            ceilMode={ceilMode}
            onCeilModeChange={onCeilModeChange}
            onOpenSettings={handleOpenSettings}
          />

          <ProductionStats
            stats={stats}
            facilities={facilities}
            items={items}
            error={error}
            warnings={warnings}
            ceilMode={ceilMode}
            rawMaterialOverCapMap={rawMaterialOverCapMap}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
