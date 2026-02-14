import { memo, useCallback, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { AlertCircle, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Facility, Item, ItemId } from "@/types";
import { getFacilityName, getItemName } from "@/lib/i18n-helpers";

type ProductionStatsProps = {
  totalPowerConsumption: number;
  productionSteps: number;
  rawMaterialRequirements: Map<ItemId, number>;
  facilityRequirements: Map<string, number>;
  facilities: Facility[];
  items: Item[];
  error: string | null;
};

const ProductionStats = memo(function ProductionStats({
  totalPowerConsumption,
  productionSteps,
  rawMaterialRequirements,
  facilityRequirements,
  facilities,
  items,
  error,
}: ProductionStatsProps) {
  const { t } = useTranslation("stats");
  const [rawMaterialsOpen, setRawMaterialsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleRawMaterialsToggle = useCallback((open: boolean) => {
    setRawMaterialsOpen(open);
    if (open) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({
            top: scrollRef.current.scrollHeight,
            behavior: "smooth",
          });
        });
      });
    }
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
      const item = items.find((i) => i.id === itemId);
      return item ? { item, rate } : null;
    })
    .filter(
      (entry): entry is { item: Item; rate: number } => entry !== null,
    )
    .sort((a, b) => getItemName(a.item).localeCompare(getItemName(b.item)));

  return (
    <Card className="min-h-0 flex flex-col border-border/50">
      <CardHeader className="shrink-0">
        <CardTitle className="text-base">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent ref={scrollRef} className="space-y-2.5 overflow-y-auto min-h-0">
        {error ? (
          <div className="flex items-center gap-2 text-destructive text-sm p-3 bg-destructive/10 rounded">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t("totalPower")}
                </div>
                <div className="text-lg font-bold font-mono">
                  {totalPowerConsumption.toFixed(1)}
                  <span className="text-xs font-normal text-muted-foreground ml-1">
                    {t("powerUnit")}
                  </span>
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
            </div>

            {facilityList.length > 0 && (
              <>
                <Separator />
                <div className="grid grid-cols-2 gap-2">
                  {facilityList.map(({ facility, count }) => (
                    <div
                      key={facility.id}
                      className="space-y-0.5 p-2 border border-border/50 bg-card"
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
                      <div className="text-sm font-semibold font-mono">
                        {count.toFixed(1)}
                      </div>
                    </div>
                  ))}
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
                      {rawMaterialList.map(({ item, rate }) => (
                        <div
                          key={item.id}
                          className="space-y-0.5 p-2 border border-border/50 bg-card"
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
                          <div className="text-sm font-semibold font-mono">
                            {rate.toFixed(1)}
                            <span className="text-xs font-normal text-muted-foreground ml-1">
                              /min
                            </span>
                          </div>
                        </div>
                      ))}
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
