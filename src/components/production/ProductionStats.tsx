import { memo, useCallback, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertCircle, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Facility, FacilityId, Item, ItemId } from "@/types";
import { getFacilityName, getItemName } from "@/lib/i18n-helpers";
import { cn, getItemById, formatCount } from "@/lib/utils";
import { rawMaterialSources } from "@/data";

type ProductionStatsProps = {
  totalPowerConsumption: number;
  productionSteps: number;
  rawMaterialRequirements: Map<ItemId, number>;
  facilityRequirements: Map<string, number>;
  totalPickupPoints: number;
  rawMaterialPickupPoints: Map<ItemId, number>;
  facilities: Facility[];
  items: Item[];
  error: string | null;
  /**
   * Whether the panel renders the physical (ceiled) view or the
   * theoretical (fractional) view. Drives `formatCount` for pickup-point
   * and facility counts so the panel matches the table footer.
   */
  ceilMode?: boolean;
  /**
   * Per-facility cap-overflow info from `useProductionStats`. Cards
   * whose facility id is in this map render with destructive border +
   * bg tint + red count value, and a tooltip showing the short
   * `(used / cap)` numeric form. Empty map → all cards render with
   * default styling.
   */
  facilityOverCapMap: ReadonlyMap<FacilityId, { used: number; cap: number }>;
  /**
   * Per-raw-item cap-overflow info from `useProductionPlan`. Mirrors
   * `facilityOverCapMap` shape. Cards whose item id is in this map
   * render with destructive border + bg tint + red rate value, and a
   * tooltip showing the short `({used}/min / {cap}/min)` form. Empty
   * map → all raw-material rows render with default styling.
   */
  rawMaterialOverCapMap: ReadonlyMap<ItemId, { used: number; cap: number }>;
};

const ProductionStats = memo(function ProductionStats({
  totalPowerConsumption,
  productionSteps,
  rawMaterialRequirements,
  facilityRequirements,
  totalPickupPoints,
  rawMaterialPickupPoints,
  facilities,
  items,
  error,
  ceilMode = false,
  facilityOverCapMap,
  rawMaterialOverCapMap,
}: ProductionStatsProps) {
  const { t } = useTranslation("stats");
  const [rawMaterialsOpen, setRawMaterialsOpen] = useState(false);

  const handleRawMaterialsToggle = useCallback((open: boolean) => {
    setRawMaterialsOpen(open);
  }, []);

  const facilityList = Array.from(facilityRequirements.entries())
    .map(([facilityId, count]) => {
      const facility = facilities.find((f) => f.id === facilityId);
      return facility ? { facility, count } : null;
    })
    .filter(
      (item): item is { facility: Facility; count: number } => item !== null,
    )
    .sort((a, b) => a.facility.id.localeCompare(b.facility.id));

  const rawMaterialList = Array.from(rawMaterialRequirements.entries())
    .map(([itemId, rate]) => {
      const item = getItemById(items, itemId);
      return item ? { item, rate } : null;
    })
    .filter((entry): entry is { item: Item; rate: number } => entry !== null)
    .sort((a, b) => getItemName(a.item).localeCompare(getItemName(b.item)));

  return (
    <Card className="flex flex-col border-border/50 shrink-0">
      <CardHeader className="shrink-0">
        <CardTitle className="text-base">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {error ? (
          <div className="flex items-center gap-2 text-destructive text-sm p-3 bg-destructive/10 rounded">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t("totalPower")}
                </div>
                <div className="text-lg font-bold font-mono">
                  {totalPowerConsumption.toFixed(1)}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t("productionSteps")}
                </div>
                <div className="text-lg font-bold font-mono">
                  {productionSteps}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t("rawMaterials")}
                </div>
                <div className="text-lg font-bold font-mono">
                  {rawMaterialRequirements.size}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t("pickupPoints")}
                </div>
                <div className="text-lg font-bold font-mono">
                  {formatCount(totalPickupPoints, ceilMode)}
                </div>
              </div>
            </div>

            {facilityList.length > 0 && (
              <>
                <Separator />
                <div className="grid grid-cols-2 gap-2">
                  {facilityList.map(({ facility, count }) => {
                    const overCap = facilityOverCapMap.get(
                      facility.id as FacilityId,
                    );
                    const card = (
                      <div
                        className={cn(
                          "space-y-0.5 p-2 border bg-card",
                          overCap
                            ? "border-destructive/70 bg-destructive/5"
                            : "border-border/50",
                        )}
                      >
                        <div className="flex items-center gap-1.5">
                          {facility.iconUrl && (
                            <img
                              src={facility.iconUrl}
                              alt={getFacilityName(facility)}
                              className="w-4 h-4 object-contain"
                            />
                          )}
                          <div className="text-xs text-muted-foreground truncate flex-1">
                            {getFacilityName(facility)}
                          </div>
                        </div>
                        <div
                          className={cn(
                            "text-sm font-semibold font-mono",
                            overCap && "text-destructive",
                          )}
                        >
                          {formatCount(count, ceilMode)}
                        </div>
                      </div>
                    );
                    if (!overCap) {
                      return (
                        <div key={facility.id}>
                          {card}
                        </div>
                      );
                    }
                    return (
                      <Tooltip key={facility.id}>
                        <TooltipTrigger asChild>{card}</TooltipTrigger>
                        <TooltipContent>
                          {t("facilityCapExceeded", {
                            used: formatCount(overCap.used, ceilMode),
                            cap: overCap.cap,
                          })}
                        </TooltipContent>
                      </Tooltip>
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
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="grid grid-cols-2 gap-2 pt-2">
                      {rawMaterialList.map(({ item, rate }) => {
                        const cfg = rawMaterialSources.get(item.id);
                        const sourceFacility = cfg
                          ? facilities.find(
                              (f) => f.id === cfg.sourceFacility,
                            )
                          : undefined;
                        const sourceLabel = sourceFacility
                          ? getFacilityName(sourceFacility)
                          : t("pickupPoints");
                        const overCap = rawMaterialOverCapMap.get(item.id);
                        const card = (
                          <div
                            className={cn(
                              "space-y-0.5 p-2 border bg-card",
                              overCap
                                ? "border-destructive/70 bg-destructive/5"
                                : "border-border/50",
                            )}
                          >
                            <div className="flex items-center gap-1.5">
                              {item.iconUrl && (
                                <img
                                  src={item.iconUrl}
                                  alt={getItemName(item)}
                                  className="w-4 h-4 object-contain"
                                />
                              )}
                              <div className="text-xs text-muted-foreground truncate flex-1">
                                {getItemName(item)}
                              </div>
                            </div>
                            <div
                              className={cn(
                                "text-sm font-semibold font-mono",
                                overCap && "text-destructive",
                              )}
                            >
                              {rate.toFixed(1)}
                              <span className="text-xs font-normal text-muted-foreground ml-1">
                                /min
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground font-mono">
                              ×{formatCount(rawMaterialPickupPoints.get(item.id) ?? 0, ceilMode)}
                              <span className="ml-1">{sourceLabel}</span>
                            </div>
                          </div>
                        );
                        if (!overCap) {
                          return <div key={item.id}>{card}</div>;
                        }
                        return (
                          <Tooltip key={item.id}>
                            <TooltipTrigger asChild>{card}</TooltipTrigger>
                            <TooltipContent>
                              {t("rawCapExceeded", {
                                used: overCap.used.toFixed(1),
                                cap: overCap.cap,
                              })}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
});

export default ProductionStats;
