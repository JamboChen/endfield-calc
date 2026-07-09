import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import type { Facility, Item, ItemId } from "@/types";
import {
  compareFacilityRows,
  type ProductionStats as ProductionStatsData,
} from "@/hooks/useProductionStats";
import { getItemName } from "@/lib/i18n-helpers";
import { cn, formatCount, getItemById } from "@/lib/utils";
import { SectionHeader } from "@/components/SectionHeader";
import {
  ByproductsList,
  FacilityStatCard,
  ImportsList,
  RawMaterialStatCard,
} from "./stat-cards";

/**
 * Shared building blocks of the Production Statistics surfaces — one
 * visual language ("telemetry deck") composed horizontally by the
 * landscape `BottomDock` and stacked vertically by the portrait
 * `ProductionStats` sheet body. Each section preps its own sorted rows
 * from the `useProductionStats` bundle so the two hosts can never
 * drift; hosts only choose layout via `className` / `listClassName`.
 */

type KpiBlockProps = {
  icon?: LucideIcon;
  label: string;
  /** Pre-formatted display value (hosts own formatCount/toFixed). */
  value: string;
  /** Native title tooltip (e.g. the grid-area lower-bound hint). */
  title?: string;
  /** Hero = dock header (large numerals); default = sheet grid. */
  hero?: boolean;
  className?: string;
};

/**
 * One telemetry readout: big tabular-numeral value over a tracked
 * uppercase micro-label. The KPI vocabulary shared by the expanded
 * dock header and the portrait sheet's summary grid.
 */
export function KpiBlock({
  icon: Icon,
  label,
  value,
  title,
  hero = false,
  className,
}: KpiBlockProps) {
  return (
    <div className={cn("min-w-0", className)} title={title}>
      <div className="flex items-baseline gap-1.5">
        {Icon && (
          <Icon
            className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <span
          className={cn(
            "font-mono font-semibold tabular-nums leading-none tracking-tight",
            hero ? "text-2xl" : "text-lg",
          )}
        >
          {value}
        </span>
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

type FacilitiesSectionProps = {
  stats: ProductionStatsData;
  facilities: Facility[];
  ceilMode: boolean;
  className?: string;
  /** Grid layout for the row list (columns differ per host). */
  listClassName?: string;
};

/**
 * The build shopping list: one row per facility type, over-cap rows
 * pinned first, then heaviest builds (mode-independent ordering via
 * `compareFacilityRows` so toggling "Round up facilities" never
 * reshuffles). Power draw / utilization detail lives in each row's
 * hover tooltip — the row itself is just icon · name · ×count.
 */
export const FacilitiesSection = memo(function FacilitiesSection({
  stats,
  facilities,
  ceilMode,
  className,
  listClassName,
}: FacilitiesSectionProps) {
  const { t } = useTranslation("stats");

  const facilityById = new Map(facilities.map((f) => [f.id, f] as const));
  const facilityList = Array.from(stats.facilityRequirements.entries())
    .map(([facilityId, count]) => {
      const facility = facilityById.get(facilityId);
      return facility ? { facility, count } : null;
    })
    .filter(
      (entry): entry is { facility: Facility; count: number } =>
        entry !== null,
    )
    .sort(
      compareFacilityRows(
        stats.facilityOverCapMap,
        stats.rawFacilityRequirements,
      ),
    );

  if (facilityList.length === 0) return null;

  return (
    <section className={className}>
      <SectionHeader label={t("facilities")} count={facilityList.length} />
      <div className={cn("grid gap-1.5", listClassName)}>
        {facilityList.map(({ facility, count }) => {
          const rawCount = stats.rawFacilityRequirements.get(facility.id) ?? 0;
          return (
            <FacilityStatCard
              key={facility.id}
              facility={facility}
              count={count}
              ceilMode={ceilMode}
              overCap={stats.facilityOverCapMap.get(facility.id)}
              powerSubtotal={facility.powerConsumption * count}
              // Utilization only means something when the shown count
              // is the ceiled build.
              utilization={
                ceilMode && count > 0
                  ? Math.min(1, rawCount / count)
                  : undefined
              }
            />
          );
        })}
      </div>
    </section>
  );
});

type SupplySectionProps = {
  stats: ProductionStatsData;
  items: Item[];
  facilities: Facility[];
  ceilMode: boolean;
  rawMaterialCapMap: ReadonlyMap<ItemId, { used: number; cap: number }>;
  className?: string;
  listClassName?: string;
};

/**
 * Raw-material inputs: tier-accented cards sorted by localized name,
 * with the pump tally as the header caption (depot ports already
 * headline in the KPI strip).
 */
export const SupplySection = memo(function SupplySection({
  stats,
  items,
  facilities,
  ceilMode,
  rawMaterialCapMap,
  className,
  listClassName,
}: SupplySectionProps) {
  const { t } = useTranslation("stats");

  const rawMaterialList = Array.from(stats.rawMaterialRequirements.entries())
    .map(([itemId, rate]) => {
      const item = getItemById(items, itemId);
      return item ? { item, rate } : null;
    })
    .filter((entry): entry is { item: Item; rate: number } => entry !== null)
    .sort((a, b) => getItemName(a.item).localeCompare(getItemName(b.item)));

  if (rawMaterialList.length === 0) return null;

  return (
    <section className={className}>
      <SectionHeader
        label={t("rawMaterialUsage")}
        count={rawMaterialList.length}
        caption={
          stats.pumpPickupPoints > 0 ? (
            <>
              <span className="font-mono">
                {formatCount(stats.pumpPickupPoints, ceilMode)}
              </span>{" "}
              {t("pumps")}
            </>
          ) : undefined
        }
      />
      <div className={cn("grid gap-1.5", listClassName)}>
        {rawMaterialList.map(({ item, rate }) => (
          <RawMaterialStatCard
            key={item.id}
            item={item}
            rate={rate}
            pickupCount={stats.rawMaterialPickupPoints.get(item.id) ?? 0}
            facilities={facilities}
            ceilMode={ceilMode}
            capInfo={rawMaterialCapMap.get(item.id)}
          />
        ))}
      </div>
    </section>
  );
});

type ImportsSectionProps = {
  stats: ProductionStatsData;
  items: Item[];
  className?: string;
};

/** Metastorage transfer routes with the section header chrome. */
export const ImportsSection = memo(function ImportsSection({
  stats,
  items,
  className,
}: ImportsSectionProps) {
  const { t } = useTranslation("stats");
  if (stats.metastorageImports.length === 0) return null;
  return (
    <section className={className}>
      <SectionHeader
        label={t("imports")}
        count={stats.metastorageImports.length}
      />
      <ImportsList imports={stats.metastorageImports} items={items} />
    </section>
  );
});

type ByproductsSectionProps = {
  stats: ProductionStatsData;
  className?: string;
};

/** Byproduct disposal flows with the section header chrome. */
export const ByproductsSection = memo(function ByproductsSection({
  stats,
  className,
}: ByproductsSectionProps) {
  const { t } = useTranslation("stats");
  if (stats.disposal.length === 0) return null;
  return (
    <section className={className}>
      <SectionHeader label={t("byproducts")} count={stats.disposal.length} />
      <ByproductsList disposal={stats.disposal} />
    </section>
  );
});
