import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Separator } from "@/components/ui/separator";
import StatsTicker from "./StatsTicker";
import { IssuesList } from "../production/stat-cards";
import {
  ByproductsSection,
  FacilitiesSection,
  ImportsSection,
  SupplySection,
} from "../production/stat-sections";
import type { Facility, Item, ItemId } from "@/types";
import type { ProductionStats } from "@/hooks/useProductionStats";
import { cn } from "@/lib/utils";
import { namespaceStorageKey } from "@/lib/storage-namespace";

const DOCK_EXPANDED_KEY = namespaceStorageKey("endfield-calc:dock-expanded-v1");

type BottomDockProps = {
  stats: ProductionStats;
  facilities: Facility[];
  items: Item[];
  error: string | null;
  /** Formatted solver warnings — sole rendering surface since the
   *  table/tree banners were retired. Cap overflows are NOT in here:
   *  the over-cap stat rows carry them visually. */
  warnings: string[];
  /** Facility + raw cap overflows (rows, not banners) — folded into
   *  the ticker badge so a collapsed dock still signals them. */
  capIssueCount: number;
  ceilMode?: boolean;
  rawMaterialCapMap: ReadonlyMap<ItemId, { used: number; cap: number }>;
};

/**
 * Landscape home of the Production Statistics: a collapsible bottom
 * dock. Collapsed it is the slim `StatsTicker`; expanded the same strip
 * grows into the hero KPI readout (power / buildings / grid / ports /
 * steps as large telemetry blocks) above a body organised as:
 *
 *   - Issues strip — full width on top (2 columns at `xl:`), so long
 *     warning texts get the width they need and problems are the first
 *     thing visible.
 *   - Three proportional zones built from the shared stat-sections:
 *     Facilities (`flex-[3]`), Raw Materials (`flex-[2]`), Logistics
 *     (`flex-[1]`, imports + byproducts; hidden when empty).
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
  capIssueCount,
  ceilMode = false,
  rawMaterialCapMap,
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

  const issueCount = warnings.length + capIssueCount + (error ? 1 : 0);
  // Map-size checks, while the sections themselves render from
  // lookup-filtered lists. Safe today: plan facility/item ids and the
  // `facilities`/`items` props derive from the same `@/data` barrel,
  // so a key that misses the lookup can't occur outside data bugs.
  const hasFacilities = stats.facilityRequirements.size > 0;
  const hasRawMaterials = stats.rawMaterialRequirements.size > 0;
  const hasLogistics =
    stats.metastorageImports.length > 0 || stats.disposal.length > 0;
  const isEmpty =
    !hasFacilities && !hasRawMaterials && !hasLogistics && issueCount === 0;

  return (
    <div className="shrink-0 rounded-lg border border-border bg-card shadow-sm overflow-hidden">
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
        expanded={expanded}
        variant={expanded && !isEmpty ? "hero" : "slim"}
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

              {(hasFacilities || hasRawMaterials || hasLogistics) && (
                <div className="flex gap-4">
                  <FacilitiesSection
                    stats={stats}
                    facilities={facilities}
                    ceilMode={ceilMode}
                    className="flex-[3] min-w-0"
                    listClassName="grid-cols-[repeat(auto-fill,minmax(200px,1fr))]"
                  />

                  {hasFacilities && hasRawMaterials && (
                    <Separator orientation="vertical" className="h-auto" />
                  )}

                  <SupplySection
                    stats={stats}
                    items={items}
                    facilities={facilities}
                    ceilMode={ceilMode}
                    rawMaterialCapMap={rawMaterialCapMap}
                    className="flex-[2] min-w-0"
                    listClassName="grid-cols-[repeat(auto-fill,minmax(210px,1fr))]"
                  />

                  {hasLogistics && (
                    <>
                      {(hasFacilities || hasRawMaterials) && (
                        <Separator
                          orientation="vertical"
                          className="h-auto"
                        />
                      )}
                      <div
                        className={cn(
                          hasFacilities || hasRawMaterials
                            ? "flex-[1] min-w-[240px]"
                            : "flex-1 min-w-0",
                          "space-y-3",
                        )}
                      >
                        <ImportsSection stats={stats} items={items} />
                        <ByproductsSection stats={stats} />
                      </div>
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
