import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sheet,
  SheetContent,
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
  /** Facility + raw cap overflows (rows, not banners) — folded into
   *  the trigger ticker's badge so a closed sheet still signals them. */
  capIssueCount: number;
  rawMaterialCapMap: ReadonlyMap<ItemId, { used: number; cap: number }>;
  ceilMode?: boolean;
};

/**
 * Portrait-mode bottom drawer, stats-only. The trigger is the same
 * `StatsTicker` strip the landscape dock uses (one visual language for
 * the plan summary); tapping it opens an 80svh sheet with the full
 * stats readout. The targets grid and Options card live on the bottom
 * nav's Plan tab (App-level), not in here — the drawer stays available
 * on both nav tabs as pure plan feedback.
 */
export default function PortraitDrawer({
  items,
  facilities,
  stats,
  error,
  warnings,
  capIssueCount,
  rawMaterialCapMap,
  ceilMode = false,
}: PortraitDrawerProps) {
  const { t } = useTranslation("stats");
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Radix's default open-autofocus lands on the first tabbable child —
  // which is an over-cap stat row when one exists, popping its tooltip
  // over the KPI grid the moment the sheet opens. Focus the scroll
  // container instead (tabIndex={-1}); keyboard Tab still reaches the
  // rows from there.
  const handleOpenAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    scrollRef.current?.focus();
  }, []);

  const issueCount = warnings.length + capIssueCount + (error ? 1 : 0);

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
          uniqueProductionSteps={stats.uniqueProductionSteps}
          groupedSavings={stats.groupedSavings}
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
        onOpenAutoFocus={handleOpenAutoFocus}
        className="h-[80svh] flex flex-col rounded-t-xl px-4 pb-0 data-[state=closed]:duration-150 data-[state=open]:duration-200"
      >
        {/* No visible header — the KPI grid and section headers are
            self-describing, and the sheet's vertical budget is better
            spent on content. Radix still requires a DialogTitle for
            screen-reader announcement, so it stays as sr-only. */}
        <SheetTitle className="sr-only">{t("title")}</SheetTitle>

        <div
          ref={scrollRef}
          tabIndex={-1}
          className="flex-1 overflow-y-auto min-h-0 pt-4 space-y-4 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none"
        >
          <ProductionStats
            stats={stats}
            facilities={facilities}
            items={items}
            error={error}
            warnings={warnings}
            ceilMode={ceilMode}
            rawMaterialCapMap={rawMaterialCapMap}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
