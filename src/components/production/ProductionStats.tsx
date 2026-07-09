import { memo } from "react";
import { Factory, LayoutGrid, Plug, Route, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Facility, Item, ItemId } from "@/types";
import type { ProductionStats as ProductionStatsData } from "@/hooks/useProductionStats";
import { formatCount } from "@/lib/utils";
import { IssuesList } from "./stat-cards";
import {
  ByproductsSection,
  FacilitiesSection,
  ImportsSection,
  KpiBlock,
  SupplySection,
} from "./stat-sections";

type ProductionStatsProps = {
  /** Cohesive stats bundle from `useProductionStats`. */
  stats: ProductionStatsData;
  facilities: Facility[];
  items: Item[];
  error: string | null;
  /** Formatted solver warnings — rendered in the Issues section. */
  warnings: string[];
  /**
   * Whether the panel renders the physical (ceiled) view or the
   * theoretical (fractional) view. Drives `formatCount` for pickup-point
   * and facility counts so the panel matches the table footer.
   */
  ceilMode?: boolean;
  /**
   * Per-raw-item `{used, cap}` for every capped raw, from
   * `useProductionPlan`. Cards whose item id is in this map render a
   * capacity bar (headroom at a glance); cards over their cap flip to
   * destructive chrome with the `({used}/min / {cap}/min)` tooltip.
   */
  rawMaterialCapMap: ReadonlyMap<ItemId, { used: number; cap: number }>;
};

/**
 * Vertical Production Statistics readout — the portrait drawer's sheet
 * body (the landscape dock arranges the same stat-sections
 * horizontally via `BottomDock`). One scroll, everything visible:
 * issues, KPI summary grid, facility rows, raw-material usage,
 * metastorage imports, byproduct disposal.
 */
const ProductionStats = memo(function ProductionStats({
  stats,
  facilities,
  items,
  error,
  warnings,
  ceilMode = false,
  rawMaterialCapMap,
}: ProductionStatsProps) {
  const { t } = useTranslation("stats");

  return (
    <div className="space-y-4">
      <IssuesList error={error} warnings={warnings} />

      {!error && (
        <>
          <div className="grid grid-cols-3 gap-x-3 gap-y-4">
            <KpiBlock
              icon={Zap}
              label={t("totalPower")}
              value={stats.totalPowerConsumption.toFixed(1)}
            />
            <KpiBlock
              icon={Factory}
              label={t("buildings")}
              value={formatCount(stats.totalBuildings, ceilMode)}
            />
            <KpiBlock
              icon={LayoutGrid}
              label={t("gridArea")}
              value={stats.totalTiles > 0 ? `≥${stats.totalTiles}` : "0"}
              title={t("gridAreaHint")}
            />
            <KpiBlock
              icon={Plug}
              label={t("depotPorts")}
              value={formatCount(stats.depotPickupPoints, ceilMode)}
            />
            <KpiBlock
              icon={Route}
              label={t("productionSteps")}
              value={String(stats.uniqueProductionSteps)}
            />
          </div>

          <FacilitiesSection
            stats={stats}
            facilities={facilities}
            ceilMode={ceilMode}
            listClassName="grid-cols-1"
          />

          <SupplySection
            stats={stats}
            items={items}
            facilities={facilities}
            ceilMode={ceilMode}
            rawMaterialCapMap={rawMaterialCapMap}
            listClassName="grid-cols-1"
          />

          <ImportsSection stats={stats} items={items} />

          <ByproductsSection stats={stats} />
        </>
      )}
    </div>
  );
});

export default ProductionStats;
