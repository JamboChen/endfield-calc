import { memo, useMemo } from "react";
import { Truck, Zap } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { ItemId } from "@/types";
import type { IneffectivePin } from "@/hooks/useProductionPlan";
import type {
  ProductionLineData,
  ProductionTableTotals,
} from "./ProductionTable";
import type { Item, Recipe, RecipeId } from "@/types";
import { useTranslation } from "react-i18next";
import {
  getDomainName,
  getFacilityName,
  getItemName,
  getRecipeName,
  getTransportLabel,
} from "@/lib/i18n-helpers";
import {
  cn,
  formatCount,
  formatNumber,
  getPickupPointCount,
  getRawSourceRate,
  getTransportCountWithFacilities,
} from "@/lib/utils";
import { rawMaterialSources, facilities as allFacilities } from "@/data";
import { FacilityIcon } from "@/components/FacilityIcon";
import {
  ItemIcon,
  RecipeIOCompact,
  RecipeSelect,
  ResetPinButton,
} from "./recipe-cells";

type ProductionCardsProps = {
  data: ProductionLineData[];
  /** Plan-level totals from `aggregateBinTotals` — never recomputed
   *  from rows (split allocations would undercount). */
  totals: ProductionTableTotals;
  items: Item[];
  /** Full AIC-filtered recipe set for ghost-card pickers. */
  recipes: readonly Recipe[];
  onRecipeChange: (itemId: ItemId, recipeId: RecipeId) => void;
  onRecipePinReset: (itemId: ItemId) => void;
  onToggleRawMaterial: (itemId: ItemId) => void;
  pinnedItemIds: ReadonlySet<ItemId>;
  ineffectivePins: IneffectivePin[];
  ceilMode?: boolean;
};

/**
 * Portrait/card rendering of the production plan — same
 * `useProductionTable` rows, totals and handlers as `ProductionTable`,
 * reshaped one-card-per-line for narrow touch screens:
 *
 *   ▎[icon] Item name                     30.00 /min
 *   ▎ [facility] Refining Unit · ×1 · ⚡5 · 1 belts
 *   ▎ [ formula picker ─────────▾ ]          [raw ⇄]
 *
 * Row-variant coverage mirrors the table: producer, raw, manual-raw,
 * metastorage-import (cyan, TTV per delivery), grouped-bin (power only
 * on the bin-primary card — displayed powers must sum to the plan
 * total), invalid-cycle, target, disposal, and ghost cards from
 * `ineffectivePins`. The table's mouse-hover dependency highlighting is
 * intentionally omitted (mouse-centric; a tap paradigm is a future
 * item). Detail tooltips ride on `title` — long-press surfaces them on
 * most mobile browsers, and the same info exists in the tree view.
 */
const ProductionCards = memo(function ProductionCards({
  data,
  totals,
  items,
  recipes,
  onRecipeChange,
  onRecipePinReset,
  onToggleRawMaterial,
  pinnedItemIds,
  ineffectivePins,
  ceilMode = false,
}: ProductionCardsProps) {
  const { t } = useTranslation("production");

  const itemById = useMemo(
    () => new Map(items.map((i) => [i.id, i] as const)),
    [items],
  );
  const getItemById = (id: ItemId) => itemById.get(id);

  if (data.length === 0 && ineffectivePins.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-8">
        {t("table.noData")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 pb-2">
      {data.map((line) => {
        const isImport = line.metastorageImport !== undefined;
        const isManualRaw = line.isManualRawMaterial === true;
        const isGrouped = (line.binSisterRecipeIds?.length ?? 0) > 0;
        const selectedRecipe = line.availableRecipes.find(
          (r) => r.id === line.selectedRecipeId,
        );

        // Bin-aware power (mirrors the table): only the bin's primary
        // card shows the bin total so card powers sum to the plan total.
        const power =
          line.isRawMaterial || isManualRaw || isImport || !line.facility
            ? null
            : isGrouped && !line.isBinPrimary
              ? "grouped"
              : line.facility.powerConsumption *
                (isGrouped
                  ? (line.binBuildingCount ?? line.facilityCount)
                  : line.facilityCount);

        // Same composite key scheme as the table — sister rows share
        // the item id.
        const key = line.isDisposal
          ? `disposal-${line.item.id}-${line.selectedRecipeId || "noproducer"}`
          : isImport
            ? `import-${line.metastorageImport!.sourceDomain}-${line.item.id}`
            : `${line.item.id}-${line.selectedRecipeId || "noproducer"}`;

        // Pickup-point info for raw rows (matches the table's Count
        // branch + the stats cards' wording).
        const sourceFacilityId = rawMaterialSources.get(
          line.item.id,
        )?.sourceFacility;
        const sourceFacility = sourceFacilityId
          ? allFacilities.find((f) => f.id === sourceFacilityId)
          : undefined;

        const showRawToggle =
          !line.isTarget &&
          !line.isDisposal &&
          !isImport &&
          !(line.isRawMaterial && !isManualRaw);

        return (
          <div
            key={key}
            className={cn(
              "rounded border border-border/40 border-l-2 bg-card px-2.5 py-2 space-y-1.5",
              line.isInvalidCycle
                ? "border-l-destructive bg-destructive/5"
                : line.isTarget
                  ? "border-l-amber-400 bg-amber-50/40 dark:bg-amber-950/15"
                  : isManualRaw
                    ? "border-l-blue-400 bg-blue-50/40 dark:bg-blue-950/15"
                    : isImport
                      ? "border-l-cyan-400 bg-cyan-50/40 dark:bg-cyan-950/15"
                      : "border-l-border",
            )}
          >
            {/* Line 1: item + rate */}
            <div className="flex items-center gap-2">
              <ItemIcon item={line.item} />
              <span className="flex-1 min-w-0 text-sm font-medium break-words leading-tight">
                {getItemName(line.item)}
              </span>
              <span className="font-mono text-sm font-semibold shrink-0">
                {formatNumber(line.outputRate)}
                <span className="text-[11px] font-normal text-muted-foreground ml-0.5">
                  /min
                </span>
              </span>
            </div>

            {/* Line 2: facility · count · power · transport */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {isImport ? (
                <span
                  className="flex items-center gap-1 text-cyan-700 dark:text-cyan-400"
                  title={t("table.metastorage.tooltip", {
                    defaultValue: "Metastorage Transfer",
                  })}
                >
                  <Truck className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="font-mono font-semibold">
                    {formatNumber(
                      line.metastorageImport!.ttvUsedPerMinute *
                        (line.metastorageImport!.cycleSeconds / 60),
                      1,
                    )}
                  </span>
                  {t("table.metastorage.ttv", { defaultValue: "TTV" })}
                </span>
              ) : line.isRawMaterial && !isManualRaw ? (
                <span className="font-mono text-green-700 dark:text-green-400">
                  ×
                  {formatCount(
                    getPickupPointCount(
                      line.outputRate,
                      getRawSourceRate(line.item.id, line.item),
                    ),
                    ceilMode,
                  )}
                  <span className="ml-1 font-sans text-muted-foreground">
                    {sourceFacility
                      ? getFacilityName(sourceFacility)
                      : t("tree.pickupPoint")}
                  </span>
                </span>
              ) : line.facility ? (
                <>
                  <span className="flex items-center gap-1 min-w-0">
                    <FacilityIcon
                      facility={line.facility}
                      alt={getFacilityName(line.facility)}
                      className="h-4 w-4 object-contain shrink-0"
                    />
                    <span className="truncate">
                      {getFacilityName(line.facility)}
                    </span>
                  </span>
                  {isGrouped ? (
                    <span
                      className="font-mono text-purple-700 dark:text-purple-400"
                      title={t("table.bin.buildingsExplain", {
                        n: line.binBuildingCount,
                        m: (line.binSisterRecipeIds?.length ?? 0) + 1,
                        defaultValue:
                          "{{n}} buildings hosting {{m}} formulas",
                      })}
                    >
                      {line.binBuildingCount}{" "}
                      <span className="font-sans">
                        {t("table.bin.buildings", {
                          defaultValue: "bldgs",
                        })}
                      </span>{" "}
                      · {formatCount(line.facilityCount, ceilMode)}{" "}
                      <span className="font-sans">
                        {t("table.bin.slotsRaw", { defaultValue: "slots" })}
                      </span>
                    </span>
                  ) : (
                    <span className="font-mono">
                      ×{formatCount(line.facilityCount, ceilMode)}
                    </span>
                  )}
                  {power !== null &&
                    (power === "grouped" ? (
                      <span
                        className="italic"
                        title={t("table.bin.powerSharedExplain", {
                          defaultValue:
                            "Power counted on the bin's primary row.",
                        })}
                      >
                        {t("table.bin.grouped", { defaultValue: "grouped" })}
                      </span>
                    ) : (
                      <span className="flex items-center gap-0.5 font-mono">
                        <Zap className="h-3 w-3" aria-hidden="true" />
                        {formatNumber(power as number, 0)}
                      </span>
                    ))}
                </>
              ) : null}
              {!isImport && (
                <span className="font-mono">
                  {formatCount(
                    getTransportCountWithFacilities(
                      line.outputRate,
                      line.item,
                      ceilMode,
                      line.facilityCount,
                    ),
                    ceilMode,
                  )}{" "}
                  <span className="font-sans">
                    {getTransportLabel(line.item)}
                  </span>
                </span>
              )}
            </div>

            {/* Line 3: formula + raw toggle */}
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                {isImport ? (
                  <div className="text-xs text-cyan-700 dark:text-cyan-400 font-medium">
                    {t("table.metastorage.label", {
                      defaultValue: "Metastorage ({{source}})",
                      source: getDomainName(
                        line.metastorageImport!.sourceDomain,
                      ),
                    })}
                  </div>
                ) : line.isRawMaterial && !isManualRaw ? (
                  <div className="text-xs text-muted-foreground">
                    {t("table.rawMaterial")}
                  </div>
                ) : isManualRaw ? (
                  <div className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                    {t("table.manualRawMaterial")}
                  </div>
                ) : line.availableRecipes.length > 1 ? (
                  <div className="flex items-center gap-1">
                    {pinnedItemIds.has(line.item.id) && (
                      <ResetPinButton
                        itemId={line.item.id}
                        onReset={onRecipePinReset}
                        label={t("table.removePin", {
                          defaultValue: "Remove pin",
                        })}
                      />
                    )}
                    <RecipeSelect
                      itemId={line.item.id}
                      availableRecipes={line.availableRecipes}
                      selectedRecipeId={line.selectedRecipeId}
                      onRecipeChange={onRecipeChange}
                      getItemById={getItemById}
                    />
                  </div>
                ) : selectedRecipe ? (
                  <div title={getRecipeName(selectedRecipe)}>
                    <RecipeIOCompact
                      recipe={selectedRecipe}
                      getItemById={getItemById}
                    />
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    {t("table.noRecipe")}
                  </div>
                )}
              </div>
              {showRawToggle && (
                <Switch
                  checked={isManualRaw}
                  onCheckedChange={() => onToggleRawMaterial(line.item.id)}
                  className="data-[state=checked]:bg-blue-500 shrink-0"
                  aria-label={
                    isManualRaw
                      ? t("table.unmarkRawMaterial")
                      : t("table.markAsRawMaterial")
                  }
                  title={
                    isManualRaw
                      ? t("table.unmarkRawMaterial")
                      : t("table.markAsRawMaterial")
                  }
                />
              )}
            </div>
          </div>
        );
      })}

      {/* Ghost cards: one per ineffective pin — the LP eliminated the
          pinned item's production; surface the pin so it can be edited
          or removed. Mirrors the table's ghost rows. */}
      {ineffectivePins.map(({ itemId, recipeId }) => {
        const item = itemById.get(itemId);
        if (!item) return null;
        const ghostAvailableRecipes = recipes.filter((r) =>
          r.outputs.some((o) => o.itemId === itemId),
        );
        const ghostSelectedRecipe = ghostAvailableRecipes.find(
          (r) => r.id === recipeId,
        );
        return (
          <div
            key={`ghost-${itemId}`}
            className="rounded border border-border/40 border-l-2 border-l-amber-400/60 bg-amber-50/30 dark:bg-amber-950/10 px-2.5 py-2 space-y-1.5 text-muted-foreground"
          >
            <div className="flex items-center gap-2">
              <ItemIcon item={item} />
              <span className="flex-1 min-w-0 text-sm font-medium break-words leading-tight">
                {getItemName(item)}
              </span>
              <span className="text-xs">—</span>
            </div>
            <div className="flex items-center gap-1">
              <ResetPinButton
                itemId={itemId}
                onReset={onRecipePinReset}
                label={t("table.removePin", { defaultValue: "Remove pin" })}
              />
              {ghostAvailableRecipes.length > 1 ? (
                <RecipeSelect
                  itemId={itemId}
                  availableRecipes={ghostAvailableRecipes}
                  selectedRecipeId={recipeId}
                  onRecipeChange={onRecipeChange}
                  getItemById={getItemById}
                />
              ) : ghostSelectedRecipe ? (
                <RecipeIOCompact
                  recipe={ghostSelectedRecipe}
                  getItemById={getItemById}
                />
              ) : null}
            </div>
          </div>
        );
      })}

      {/* Totals strip — from `totals`, never row-summed. */}
      {data.length > 0 && (
        <div className="border-t mt-1 pt-2 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs">
          {data
            .filter((d) => d.metastorageImport)
            .map((d) => {
              const imp = d.metastorageImport!;
              const cycleMinutes = imp.cycleSeconds / 60;
              const used = imp.ttvUsedPerMinute * cycleMinutes;
              const cap = imp.ttvBudgetPerMinute * cycleMinutes;
              const over = imp.ttvUsedPerMinute > imp.ttvBudgetPerMinute + 1e-6;
              return (
                <span
                  key={`ttv-${imp.sourceDomain}-${imp.itemId}`}
                  className={cn(
                    "flex items-center gap-1",
                    over
                      ? "text-destructive"
                      : "text-cyan-700 dark:text-cyan-400",
                  )}
                >
                  <Truck className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("table.totals.ttv", {
                    defaultValue: "TTV ({{source}})",
                    source: getDomainName(imp.sourceDomain),
                  })}
                  :
                  <span className="font-mono font-semibold">
                    {formatNumber(used, 1)} / {formatNumber(cap, 0)}
                  </span>
                </span>
              );
            })}
          <span className="text-muted-foreground">
            {t("table.totals.buildings", { defaultValue: "Total buildings" })}:{" "}
            <span className="font-mono font-semibold text-foreground">
              {formatCount(totals.totalBuildings, ceilMode)}
            </span>
            {totals.groupedSavings > 0 && (
              <span className="text-purple-700 dark:text-purple-400 ml-1">
                (−{totals.groupedSavings}{" "}
                {t("table.totals.viaGrouping", {
                  defaultValue: "via grouping",
                })}
                )
              </span>
            )}
          </span>
          <span className="text-muted-foreground">
            {t("table.totals.power", { defaultValue: "Total power" })}:{" "}
            <span className="font-mono font-semibold text-foreground">
              {formatNumber(totals.totalPower, 0)}
            </span>
          </span>
        </div>
      )}
    </div>
  );
});

export default ProductionCards;
