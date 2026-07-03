import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import StatsTicker from "./StatsTicker";
import ProductionStats from "../production/ProductionStats";
import type { Facility, Item, ItemId } from "@/types";
import type { ProductionStats as ProductionStatsData } from "@/hooks/useProductionStats";

type PortraitDrawerProps = {
  items: Item[];
  facilities: Facility[];
  stats: ProductionStatsData;
  error: string | null;
  warnings: string[];
  rawMaterialOverCapMap: ReadonlyMap<ItemId, { used: number; cap: number }>;
  ceilMode?: boolean;
};

/**
 * Portrait-mode bottom drawer, stats-only. The trigger is the same
 * `StatsTicker` strip the landscape dock uses (one visual language for
 * the plan summary); tapping it opens an 80svh sheet with the full
 * stats card. The targets grid and Options card live on the bottom
 * nav's Plan tab (App-level), not in here — the drawer stays available
 * on both nav tabs as pure plan feedback.
 */
export default function PortraitDrawer({
  items,
  facilities,
  stats,
  error,
  warnings,
  rawMaterialOverCapMap,
  ceilMode = false,
}: PortraitDrawerProps) {
  const { t: tTargets } = useTranslation("targets");
  const [open, setOpen] = useState(false);

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
          <SheetTitle>
            {tTargets("planOverview", { defaultValue: "Plan Overview" })}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
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
