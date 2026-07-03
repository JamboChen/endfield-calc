import { memo, useCallback, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Facility, Item, ItemId } from "@/types";
import {
  compareFacilityRows,
  type ProductionStats as ProductionStatsData,
} from "@/hooks/useProductionStats";
import { getItemName } from "@/lib/i18n-helpers";
import { getItemById, formatCount } from "@/lib/utils";
import {
  ByproductsList,
  FacilityStatCard,
  ImportsList,
  IssuesList,
  RawMaterialStatCard,
} from "./stat-cards";

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
   * Per-raw-item cap-overflow info from `useProductionPlan`. Cards
   * whose item id is in this map render with destructive chrome and a
   * tooltip showing the short `({used}/min / {cap}/min)` form.
   */
  rawMaterialOverCapMap: ReadonlyMap<ItemId, { used: number; cap: number }>;
};

/**
 * Vertical Production Statistics card — the portrait drawer's stats
 * surface (the landscape dock renders the same data horizontally via
 * `BottomDock`). Sections: summary grid (power / buildings / grid area /
 * depot ports / steps / raws), facility cards, collapsible raw-material
 * usage, metastorage imports, byproduct disposal, and the full issues
 * list.
 */
const ProductionStats = memo(function ProductionStats({
  stats,
  facilities,
  items,
  error,
  warnings,
  ceilMode = false,
  rawMaterialOverCapMap,
}: ProductionStatsProps) {
  const { t } = useTranslation("stats");
  const [rawMaterialsOpen, setRawMaterialsOpen] = useState(false);

  const handleRawMaterialsToggle = useCallback((open: boolean) => {
    setRawMaterialsOpen(open);
  }, []);

  const facilityById = new Map(facilities.map((f) => [f.id, f] as const));

  // Same ordering as the dock: over-cap rows pinned first, then
  // heaviest builds by mode-independent raw LP counts, so toggling
  // "Round up facilities" never reshuffles the list.
  const facilityList = Array.from(stats.facilityRequirements.entries())
    .map(([facilityId, count]) => {
      const facility = facilityById.get(facilityId);
      return facility ? { facility, count } : null;
    })
    .filter(
      (item): item is { facility: Facility; count: number } => item !== null,
    )
    .sort(
      compareFacilityRows(
        stats.facilityOverCapMap,
        stats.rawFacilityRequirements,
      ),
    );

  const rawMaterialList = Array.from(stats.rawMaterialRequirements.entries())
    .map(([itemId, rate]) => {
      const item = getItemById(items, itemId);
      return item ? { item, rate } : null;
    })
    .filter((entry): entry is { item: Item; rate: number } => entry !== null)
    .sort((a, b) => getItemName(a.item).localeCompare(getItemName(b.item)));

  const summary: { label: string; value: string; title?: string }[] = [
    { label: t("totalPower"), value: stats.totalPowerConsumption.toFixed(1) },
    {
      label: t("buildings"),
      value: formatCount(stats.totalBuildings, ceilMode),
    },
    {
      label: t("gridArea"),
      value: stats.totalTiles > 0 ? `≥${stats.totalTiles}` : "0",
      title: t("gridAreaHint"),
    },
    {
      label: t("depotPorts"),
      value: formatCount(stats.depotPickupPoints, ceilMode),
    },
    { label: t("productionSteps"), value: String(stats.uniqueProductionSteps) },
    {
      label: t("rawMaterials"),
      value: String(stats.rawMaterialRequirements.size),
    },
  ];

  return (
    <Card className="flex flex-col border-border/50 shrink-0">
      <CardHeader className="shrink-0">
        <CardTitle className="text-base">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        <IssuesList error={error} warnings={warnings} />

        {!error && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {summary.map(({ label, value, title }) => (
                <div key={label} className="space-y-1" title={title}>
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="text-lg font-bold font-mono">{value}</div>
                </div>
              ))}
            </div>

            {facilityList.length > 0 && (
              <>
                <Separator />
                <div className="grid grid-cols-1 gap-1.5">
                  {facilityList.map(({ facility, count }) => {
                    const rawCount =
                      stats.rawFacilityRequirements.get(facility.id) ?? 0;
                    return (
                      <FacilityStatCard
                        key={facility.id}
                        facility={facility}
                        count={count}
                        ceilMode={ceilMode}
                        overCap={stats.facilityOverCapMap.get(facility.id)}
                        powerSubtotal={facility.powerConsumption * count}
                        utilization={
                          ceilMode && count > 0
                            ? Math.min(1, rawCount / count)
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              </>
            )}

            {rawMaterialList.length > 0 && (
              <>
                <Separator />
                <Collapsible
                  open={rawMaterialsOpen}
                  onOpenChange={handleRawMaterialsToggle}
                >
                  <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-sm font-medium hover:text-foreground/80 transition-colors cursor-pointer">
                    <ChevronRight
                      className={`h-4 w-4 shrink-0 transition-transform duration-200 ${rawMaterialsOpen ? "rotate-90" : ""}`}
                    />
                    {t("rawMaterialUsage")}
                    {stats.pumpPickupPoints > 0 && (
                      <span className="ml-auto text-xs text-muted-foreground font-normal font-mono">
                        {formatCount(stats.pumpPickupPoints, ceilMode)}{" "}
                        <span className="font-sans">{t("pumps")}</span>
                      </span>
                    )}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="grid grid-cols-1 gap-1.5 pt-2">
                      {rawMaterialList.map(({ item, rate }) => (
                        <RawMaterialStatCard
                          key={item.id}
                          item={item}
                          rate={rate}
                          pickupCount={
                            stats.rawMaterialPickupPoints.get(item.id) ?? 0
                          }
                          facilities={facilities}
                          ceilMode={ceilMode}
                          overCap={rawMaterialOverCapMap.get(item.id)}
                        />
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </>
            )}

            {stats.metastorageImports.length > 0 && (
              <>
                <Separator />
                <div className="text-sm font-medium">{t("imports")}</div>
                <ImportsList imports={stats.metastorageImports} items={items} />
              </>
            )}

            {stats.disposal.length > 0 && (
              <>
                <Separator />
                <div className="text-sm font-medium">{t("byproducts")}</div>
                <ByproductsList disposal={stats.disposal} />
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
});

export default ProductionStats;
