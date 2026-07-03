import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Separator } from "@/components/ui/separator";
import StatsTicker from "./StatsTicker";
import {
  ByproductsList,
  FacilityStatCard,
  ImportsList,
  IssuesList,
  RawMaterialStatCard,
} from "../production/stat-cards";
import type { Facility, Item, ItemId } from "@/types";
import {
  compareFacilityRows,
  type ProductionStats,
} from "@/hooks/useProductionStats";
import { getItemName } from "@/lib/i18n-helpers";
import { cn, formatCount, getItemById } from "@/lib/utils";
import { namespaceStorageKey } from "@/lib/storage-namespace";

const DOCK_EXPANDED_KEY = namespaceStorageKey("endfield-calc:dock-expanded-v1");

/** Section micro-label, matching the app's uppercase-tracking idiom. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-2">
      {children}
    </div>
  );
}

type BottomDockProps = {
  stats: ProductionStats;
  facilities: Facility[];
  items: Item[];
  error: string | null;
  /** Formatted solver warnings — sole rendering surface since the
   *  table/tree banners were retired. */
  warnings: string[];
  ceilMode?: boolean;
  rawMaterialOverCapMap: ReadonlyMap<ItemId, { used: number; cap: number }>;
};

/**
 * Landscape home of the Production Statistics: a collapsible bottom
 * dock. Collapsed it is the slim `StatsTicker`; expanded it adds a
 * body organised as:
 *
 *   - Issues strip — full width on top (2 columns at `xl:`), so long
 *     warning texts get the width they need and problems are the first
 *     thing visible.
 *   - Three proportional zones: Facilities (`flex-[3]`, row grid sorted
 *     over-cap → count desc), Raw Materials (`flex-[2]`, tier-accented
 *     row grid), Logistics (`flex-[1]`, imports + byproducts; hidden
 *     when empty).
 *
 * The expanded/collapsed preference persists per browser via
 * localStorage (namespaced for the beta channel). Default: expanded.
 */
const BottomDock = memo(function BottomDock({
  stats,
  facilities,
  items,
  error,
  warnings,
  ceilMode = false,
  rawMaterialOverCapMap,
}: BottomDockProps) {
  const { t } = useTranslation("stats");
  const [expanded, setExpanded] = useState<boolean>(
    () => localStorage.getItem(DOCK_EXPANDED_KEY) !== "0",
  );

  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      localStorage.setItem(DOCK_EXPANDED_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const facilityById = new Map(facilities.map((f) => [f.id, f] as const));

  // Over-cap rows pinned first, then heaviest builds — "what is this
  // plan asking me to build" reads top-left first. Ordered by the
  // mode-independent raw LP counts so toggling "Round up facilities"
  // never reshuffles the grid (see `compareFacilityRows`).
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

  const rawMaterialList = Array.from(stats.rawMaterialRequirements.entries())
    .map(([itemId, rate]) => {
      const item = getItemById(items, itemId);
      return item ? { item, rate } : null;
    })
    .filter((entry): entry is { item: Item; rate: number } => entry !== null)
    .sort((a, b) => getItemName(a.item).localeCompare(getItemName(b.item)));

  const issueCount = warnings.length + (error ? 1 : 0);
  const hasLogistics =
    stats.metastorageImports.length > 0 || stats.disposal.length > 0;
  const isEmpty =
    facilityList.length === 0 &&
    rawMaterialList.length === 0 &&
    !hasLogistics &&
    issueCount === 0;

  return (
    <div className="shrink-0 rounded-lg border border-border bg-card shadow-sm overflow-hidden">
      <StatsTicker
        totalPowerConsumption={stats.totalPowerConsumption}
        totalBuildings={stats.totalBuildings}
        totalTiles={stats.totalTiles}
        depotPickupPoints={stats.depotPickupPoints}
        issueCount={issueCount}
        ceilMode={ceilMode}
        error={error}
        expanded={expanded}
        onToggle={handleToggle}
      />

      {expanded && (
        <div className="border-t border-border max-h-[min(260px,30vh)] overflow-y-auto p-4 space-y-3">
          {isEmpty ? (
            <div className="text-sm text-muted-foreground text-center py-4">
              {t("empty")}
            </div>
          ) : (
            <>
              {/* Issues strip — full width so long warning sentences
                  don't fight a narrow column. */}
              <IssuesList
                error={error}
                warnings={warnings}
                className="xl:grid-cols-2"
              />

              {(facilityList.length > 0 ||
                rawMaterialList.length > 0 ||
                hasLogistics) && (
                <div className="flex gap-4">
                  {facilityList.length > 0 && (
                    <section className="flex-[3] min-w-0">
                      <SectionLabel>
                        {t("facilities")}
                        <span className="font-mono normal-case tracking-normal">
                          {facilityList.length}
                        </span>
                        <span className="font-normal normal-case tracking-normal">
                          Σ{" "}
                          <span className="font-mono">
                            {formatCount(stats.totalBuildings, ceilMode)}
                          </span>
                          {stats.groupedSavings > 0 && (
                            <span className="ml-1">
                              {t("groupedSavings", {
                                n: stats.groupedSavings,
                              })}
                            </span>
                          )}
                        </span>
                        <span className="font-normal normal-case tracking-normal ml-auto">
                          {t("productionSteps")}:{" "}
                          <span className="font-mono">
                            {stats.uniqueProductionSteps}
                          </span>
                        </span>
                      </SectionLabel>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-1.5">
                        {facilityList.map(({ facility, count }) => {
                          const rawCount =
                            stats.rawFacilityRequirements.get(facility.id) ??
                            0;
                          return (
                            <FacilityStatCard
                              key={facility.id}
                              facility={facility}
                              count={count}
                              ceilMode={ceilMode}
                              overCap={stats.facilityOverCapMap.get(
                                facility.id,
                              )}
                              powerSubtotal={
                                facility.powerConsumption * count
                              }
                              // Utilization only means something when
                              // the shown count is the ceiled build.
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
                  )}

                  {facilityList.length > 0 && rawMaterialList.length > 0 && (
                    <Separator orientation="vertical" className="h-auto" />
                  )}

                  {rawMaterialList.length > 0 && (
                    <section className="flex-[2] min-w-0">
                      <SectionLabel>
                        {t("rawMaterialUsage")}
                        <span className="font-mono normal-case tracking-normal">
                          {rawMaterialList.length}
                        </span>
                        <span className="font-normal normal-case tracking-normal ml-auto font-mono">
                          {formatCount(stats.depotPickupPoints, ceilMode)}{" "}
                          <span className="font-sans">{t("depotPorts")}</span>
                          {stats.pumpPickupPoints > 0 && (
                            <>
                              {" · "}
                              {formatCount(stats.pumpPickupPoints, ceilMode)}{" "}
                              <span className="font-sans">{t("pumps")}</span>
                            </>
                          )}
                        </span>
                      </SectionLabel>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-1.5">
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
                    </section>
                  )}

                  {hasLogistics && (
                    <>
                      {(facilityList.length > 0 ||
                        rawMaterialList.length > 0) && (
                        <Separator
                          orientation="vertical"
                          className="h-auto"
                        />
                      )}
                      <section
                        className={cn(
                          facilityList.length > 0 ||
                            rawMaterialList.length > 0
                            ? "flex-[1] min-w-[260px]"
                            : "flex-1 min-w-0",
                          "space-y-3",
                        )}
                      >
                        {stats.metastorageImports.length > 0 && (
                          <div>
                            <SectionLabel>
                              {t("imports")}
                              <span className="font-mono normal-case tracking-normal">
                                {stats.metastorageImports.length}
                              </span>
                            </SectionLabel>
                            <ImportsList
                              imports={stats.metastorageImports}
                              items={items}
                            />
                          </div>
                        )}
                        {stats.disposal.length > 0 && (
                          <div>
                            <SectionLabel>
                              {t("byproducts")}
                              <span className="font-mono normal-case tracking-normal">
                                {stats.disposal.length}
                              </span>
                            </SectionLabel>
                            <ByproductsList disposal={stats.disposal} />
                          </div>
                        )}
                      </section>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});

export default BottomDock;
