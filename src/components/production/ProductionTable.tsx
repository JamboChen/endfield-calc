import { memo, useCallback, useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import type { Item, Recipe, Facility, ItemId, RecipeId, BinId } from "@/types";
import { useTranslation } from "react-i18next";
import { getTransportLabel, getTransportTooltip, getFacilityName, getItemName, getRecipeName } from "@/lib/i18n-helpers";
import { getTransportCountWithFacilities, getPickupPointCount, getRawSourceRate, formatCount, formatNumber } from "@/lib/utils";
import { rawMaterialSources, facilities as allFacilities } from "@/data";

export type ProductionLineData = {
  item: Item;
  outputRate: number;
  availableRecipes: readonly Recipe[];
  selectedRecipeId: RecipeId | "";
  facility: Facility | null;
  facilityCount: number;
  isRawMaterial?: boolean;
  isTarget?: boolean;
  isManualRawMaterial?: boolean;
  isInvalidCycle?: boolean;
  isDisposal?: boolean;
  directDependencyItemIds?: Set<ItemId>;
  /**
   * Bin id when this recipe is hosted in a multi-formula bin (Phase 3).
   * Always set for non-raw-material recipes after Phase 3 runs.
   */
  binId?: BinId;
  /** Sister recipes in the same bin (excluding self). */
  binSisterRecipeIds?: RecipeId[];
  /**
   * Number of physical buildings hosting this recipe's bin. Used for the
   * Count column when the recipe is in a grouped bin (≥ 2 formulas), so
   * the displayed value matches the actual building count rather than
   * raw slot count.
   */
  binBuildingCount?: number;
  /**
   * True when this row owns the bin's power total. By convention the
   * row whose recipe id is alphabetically first in the bin owns the
   * total; other rows in the same bin display "(grouped)". Sums of
   * displayed power across rows match the plan-level power exactly.
   */
  isBinPrimary?: boolean;
  /**
   * All bins this recipe is allocated to, with per-bin building count.
   * Usually one entry; populated from `RecipeBinAllocation.perBin` so
   * split allocations (one recipe spanning multiple bin shapes) can be
   * surfaced in the UI tooltip.
   */
  binSpanningInfo?: Array<{ binId: BinId; buildingCount: number; slots: number }>;
  /**
   * Active producers for this item when the LP returned a mixed-strategy
   * solution (≥ 2 recipes producing the same item with positive facility
   * counts). Empty / undefined when there is exactly one producer (the
   * common case under HiGHS simplex on current data). When length ≥ 2,
   * the table row renders a small `(+N more)` hint next to the dominant
   * formula in the dropdown trigger, with a tooltip listing each
   * alternative and its facility share. Selecting an alternative in
   * the dropdown pins it via `onRecipeChange`, narrowing the LP to that
   * single formula.
   */
  activeProducers?: Array<{ recipeId: RecipeId; facilityCount: number }>;
};

/**
 * Plan-level totals shown in the production-table footer. Computed
 * upstream from `plan.bins` so split allocations are counted
 * correctly. Caller-provided to keep this component a pure renderer.
 */
export type ProductionTableTotals = {
  totalBuildings: number;
  totalPower: number;
  groupedSavings: number;
};

type ProductionTableProps = {
  data: ProductionLineData[];
  /**
   * Plan-level totals from `aggregateBinTotals` (via `useProductionTable`).
   * Required because the table footer must always reflect the bin-aware
   * single source of truth — recomputing totals from row data here would
   * undercount whenever the ILP splits a recipe across bins. See
   * `aggregateBinTotals` for the rounding semantics tied to `ceilMode`.
   */
  totals: ProductionTableTotals;
  items: Item[];
  onRecipeChange: (itemId: ItemId, recipeId: RecipeId) => void;
  onToggleRawMaterial: (itemId: ItemId) => void;
  ceilMode?: boolean;
};

const sizeClasses = {
  sm: { icon: "h-4 w-4 object-contain inline-block", fallback: "inline-block w-4 h-4 bg-muted rounded text-[5px] text-center leading-4" },
  md: { icon: "h-8 w-8 object-contain inline-block", fallback: "inline-block w-8 h-8 bg-muted rounded text-[7px] text-center leading-3" },
} as const;

const ItemIcon = memo(({ item, size = "md" }: { item: Item; size?: "sm" | "md" }) => {
  const itemName = getItemName(item);
  const classes = sizeClasses[size];

  if (item.iconUrl) {
    return (
      <img
        src={item.iconUrl}
        alt={itemName}
        className={classes.icon}
      />
    );
  }

  return (
    <span className={classes.fallback}>
      ?
    </span>
  );
});

ItemIcon.displayName = "ItemIcon";

const RecipeIOCompact = memo(
  ({
    recipe,
    getItemById,
  }: {
    recipe: Recipe;
    getItemById: (id: ItemId) => Item | undefined;
  }) => {
    const maxDisplay = 2;

    const renderItems = (
      recipeItems: Array<{ itemId: ItemId; amount: number }>,
      max: number,
    ) => {
      const displayed = recipeItems.slice(0, max);
      const remaining = recipeItems.length - max;

      return (
        <>
          {displayed.map((ri, idx) => {
            const item = getItemById(ri.itemId);
            return (
              <span
                key={ri.itemId}
                className="inline-flex items-center gap-0.5"
              >
                {item && <ItemIcon item={item} />}
                <span className="text-[15px]">×{ri.amount}</span>
                {idx < displayed.length - 1 && (
                  <span className="text-muted-foreground mx-0.5">+</span>
                )}
              </span>
            );
          })}
          {remaining > 0 && (
            <span className="text-[11px] text-muted-foreground ml-0.5">
              +{remaining}
            </span>
          )}
        </>
      );
    };

    return (
      <div className="flex items-center gap-0.5 text-xs flex-wrap">
        {renderItems(recipe.inputs, maxDisplay)}
        <span className="text-muted-foreground mx-0.5">→</span>
        {renderItems(recipe.outputs, maxDisplay)}
        <span className="text-[13px] text-muted-foreground ml-0.5">
          ({recipe.craftingTime}s)
        </span>
      </div>
    );
  },
);

RecipeIOCompact.displayName = "RecipeIOCompact";

const RecipeIOFull = memo(
  ({
    recipe,
    getItemById,
  }: {
    recipe: Recipe;
    getItemById: (id: ItemId) => Item | undefined;
  }) => {
    const { t } = useTranslation("production");
    const renderItems = (
      recipeItems: Array<{ itemId: ItemId; amount: number }>,
    ) => {
      return recipeItems.map((ri, idx) => {
        const item = getItemById(ri.itemId);
        const itemName = item ? getItemName(item) : ri.itemId;
        return (
          <span key={ri.itemId} className="inline-flex items-center gap-1">
            {item?.iconUrl && (
              <img
                src={item.iconUrl}
                alt={itemName}
                className="h-4 w-4 object-contain inline-block"
              />
            )}
            <span>
              {itemName} ×{ri.amount}
            </span>
            {idx < recipeItems.length - 1 && (
              <span className="text-muted-foreground mx-1">+</span>
            )}
          </span>
        );
      });
    };

    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-muted-foreground text-xs">
            {t("recipe.inputs")}:
          </span>
          {renderItems(recipe.inputs)}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-muted-foreground text-xs">
            {t("recipe.outputs")}:
          </span>
          {renderItems(recipe.outputs)}
        </div>
        <div className="text-xs text-muted-foreground">
          {t("recipe.time")}: {recipe.craftingTime}s
        </div>
      </div>
    );
  },
);

RecipeIOFull.displayName = "RecipeIOFull";

const FacilityIcon = memo(
  ({
    facility,
    isRawMaterial,
  }: {
    facility: Facility | null;
    isRawMaterial?: boolean;
  }) => {
    if (isRawMaterial || !facility) {
      return <div className="flex justify-center">-</div>;
    }

    const facilityName = getFacilityName(facility);

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex justify-center cursor-help">
            {facility.iconUrl ? (
              <img
                src={facility.iconUrl}
                alt={facilityName}
                className="h-8 w-8 object-contain"
              />
            ) : (
              <div className="h-8 w-8 bg-muted rounded flex items-center justify-center">
                <span className="text-[10px]">🏭</span>
              </div>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">{facilityName}</p>
        </TooltipContent>
      </Tooltip>
    );
  },
);

FacilityIcon.displayName = "FacilityIcon";

const ProductionTable = memo(function ProductionTable({
  data,
  totals,
  items,
  onRecipeChange,
  onToggleRawMaterial,
  ceilMode = false,
}: ProductionTableProps) {
  const { t } = useTranslation("production");
  const [hoveredItemId, setHoveredItemId] = useState<ItemId | null>(null);

  const getItemById = useCallback(
    (itemId: ItemId): Item | undefined => {
      return items.find((item) => item.id === itemId);
    },
    [items],
  );


  const highlightedItemIds = useMemo(() => {
    if (!hoveredItemId) return new Set<ItemId>();

    const highlighted = new Set<ItemId>();
    highlighted.add(hoveredItemId); // Add the hovered item itself

    // Find the hovered line and add its direct dependencies
    const hoveredLine = data.find((line) => line.item.id === hoveredItemId);
    if (hoveredLine?.directDependencyItemIds) {
      hoveredLine.directDependencyItemIds.forEach((depId) => {
        highlighted.add(depId);
      });
    }

    return highlighted;
  }, [hoveredItemId, data]);

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent border-b-2">
            <TableHead className="h-8 w-52 bg-muted/30 font-semibold">
              {t("table.headers.item")}
            </TableHead>
            <TableHead className="text-right h-8 w-[100px] bg-muted/30 font-semibold">
              {t("table.headers.outputRate")}
            </TableHead>
            <TableHead className="text-right h-8 w-[100px] bg-muted/30 font-semibold">
              {t("table.headers.belts")}
            </TableHead>
            <TableHead className="h-8 w-14 text-center bg-muted/30 font-semibold">
              {t("table.headers.facility")}
            </TableHead>
            <TableHead className="text-right h-8 w-[90px] bg-muted/30 font-semibold">
              {t("table.headers.count")}
            </TableHead>
            <TableHead className="h-8 min-w-[280px] bg-muted/30 font-semibold">
              {t("table.headers.recipe")}
            </TableHead>
            <TableHead className="text-right h-8 w-[100px] bg-muted/30 font-semibold">
              {t("table.headers.power")}
            </TableHead>
            <TableHead className="w-16 h-8 text-center bg-muted/30 font-semibold">
              {t("table.headers.rawMaterial")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={8}
                className="text-center text-muted-foreground h-32"
              >
                {t("table.noData")}
              </TableCell>
            </TableRow>
          ) : (
            data.map((line) => {
              const selectedRecipe = line.availableRecipes.find(
                (r) => r.id === line.selectedRecipeId,
              );
              const isGrouped =
                line.binSisterRecipeIds !== undefined &&
                line.binSisterRecipeIds.length > 0;
              // Power: for grouped bins, the bin's full power
              // (powerConsumption × buildingCount) is attributed to the bin's
              // primary row; other rows in the bin show 0 (visually "—").
              // For non-grouped (singleton) recipes, power is the standard
              // facility.powerConsumption × facilityCount.
              const totalPower = (() => {
                if (!line.facility?.powerConsumption) return 0;
                if (isGrouped && line.binBuildingCount !== undefined) {
                  return line.isBinPrimary
                    ? line.facility.powerConsumption * line.binBuildingCount
                    : 0;
                }
                return line.facility.powerConsumption * line.facilityCount;
              })();

              const isManualRaw = line.isManualRawMaterial;

              const shouldDim =
                hoveredItemId !== null && !highlightedItemIds.has(line.item.id);
              const isHovered = hoveredItemId === line.item.id;
              const isDependency =
                hoveredItemId !== null &&
                !isHovered &&
                highlightedItemIds.has(line.item.id);

              // Determine row styling
              let rowClassName = "h-12 transition-all duration-200";
              if (line.isInvalidCycle) {
                rowClassName =
                  "h-12 transition-all duration-200 bg-red-50/50 dark:bg-red-900/10 hover:bg-red-100/70 dark:hover:bg-red-900/30";
              } else if (line.isTarget) {
                rowClassName =
                  "h-12 transition-all duration-200 bg-amber-50/50 dark:bg-amber-900/10 hover:bg-amber-100/70 dark:hover:bg-amber-900/30";
              } else if (isManualRaw) {
                rowClassName =
                  "h-12 transition-all duration-200 bg-blue-50/50 dark:bg-blue-900/10 hover:bg-blue-100/70 dark:hover:bg-blue-900/30";
              }
              if (isDependency) {
                rowClassName += " bg-green-50/30 dark:bg-green-900/10";
              }

              return (
                <TableRow
                  key={line.isDisposal ? `disposal-${line.item.id}` : line.item.id}
                  className={[
                    rowClassName,
                    shouldDim && "opacity-30",
                    isHovered && "ring-2 ring-inset ring-blue-500/60 shadow-sm",
                    isDependency && "ring-1 ring-inset ring-green-500/40",
                    line.isInvalidCycle && "ring-1 ring-inset ring-red-500/40",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseEnter={() => setHoveredItemId(line.item.id)}
                  onMouseLeave={() => setHoveredItemId(null)}
                >
                  {/* Item (icon + name merged) */}
                  <TableCell
                    className={[
                      "p-2 relative",
                      line.isInvalidCycle &&
                        "before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:bg-red-500",
                      line.isTarget &&
                        !line.isInvalidCycle &&
                        "before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:bg-amber-500",
                      isManualRaw &&
                        !line.isInvalidCycle &&
                        "before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:bg-blue-500",
                      isHovered &&
                        "after:absolute after:left-0 after:top-0 after:h-full after:w-1 after:bg-blue-500 after:shadow-[0_0_8px_rgba(59,130,246,0.5)]",
                      isDependency &&
                        !line.isTarget &&
                        !isManualRaw &&
                        "after:absolute after:left-0 after:top-0 after:h-full after:w-1 after:bg-green-500 after:shadow-[0_0_6px_rgba(34,197,94,0.4)]",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <div className="flex items-center gap-2">
                      {line.item.iconUrl ? (
                        <img
                          src={line.item.iconUrl}
                          alt={getItemName(line.item)}
                          className="h-8 w-8 object-contain shrink-0"
                        />
                      ) : (
                        <div className="h-8 w-8 bg-muted rounded flex items-center justify-center shrink-0">
                          <span className="text-[10px]">📦</span>
                        </div>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="font-medium text-sm truncate cursor-help">
                            {getItemName(line.item)}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          <p className="text-xs">{getItemName(line.item)}</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>

                  {/* Output rate */}
                  <TableCell className="text-right font-mono text-sm tabular-nums p-2">
                    <div className="flex flex-col items-end">
                      <span>{formatNumber(line.outputRate)}</span>
                      <span className="text-[10px] text-muted-foreground">
                        /min
                      </span>
                    </div>
                  </TableCell>

                  {/* Belts / Pipes */}
                  <TableCell className="text-right font-mono text-sm tabular-nums p-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex flex-col items-end cursor-help">
                          <span>{formatCount(getTransportCountWithFacilities(line.outputRate, line.item, ceilMode, line.facilityCount), ceilMode)}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {getTransportLabel(line.item)}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          {getTransportTooltip(line.item)}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>

                  {/* Facility icon */}
                  <TableCell className="p-2">
                    <FacilityIcon
                      facility={line.facility}
                      isRawMaterial={line.isRawMaterial || isManualRaw}
                    />
                  </TableCell>

                  {/* Facility count */}
                  <TableCell className="text-right font-mono text-sm tabular-nums p-2">
                    {line.isRawMaterial ? (() => {
                      const cfg = rawMaterialSources.get(line.item.id);
                      const sourceFac = cfg
                        ? allFacilities.find((f) => f.id === cfg.sourceFacility)
                        : undefined;
                      const tooltipLabel = sourceFac
                        ? getFacilityName(sourceFac)
                        : t("tree.pickupPoint");
                      return (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-green-600 dark:text-green-400 cursor-help">
                              {formatCount(getPickupPointCount(line.outputRate, getRawSourceRate(line.item.id, line.item)), ceilMode)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="text-xs">{tooltipLabel}</p>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })() : isManualRaw ? (
                      <span className="text-muted-foreground">-</span>
                    ) : isGrouped && line.binBuildingCount !== undefined ? (
                      // Grouped bin: surface the bin's building count
                      // alongside the recipe's slot count. Buildings are the
                      // physical reality (1 Expanded ≠ 1 slot). When the
                      // recipe is split across multiple bin shapes, the
                      // tooltip lists every bin the recipe spans.
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex flex-col items-end cursor-help">
                            <span className="text-purple-700 dark:text-purple-400 font-semibold">
                              {formatCount(line.binBuildingCount, ceilMode)}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {t("table.bin.slots", {
                                defaultValue: "{{slots}} slots",
                                slots: formatCount(line.facilityCount, ceilMode),
                              })}
                            </span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="max-w-[280px]">
                          <div className="text-xs space-y-1">
                            <div className="font-semibold">
                              {t("tree.multiFormulaGroup", {
                                defaultValue: "Multi-Formula Building",
                              })}
                            </div>
                            <div className="text-muted-foreground">
                              {t("table.bin.buildingsExplain", {
                                defaultValue:
                                  "{{n}} buildings shared across {{m}} formulas",
                                n: formatCount(line.binBuildingCount, ceilMode),
                                m: (line.binSisterRecipeIds?.length ?? 0) + 1,
                              })}
                            </div>
                            {line.binSpanningInfo &&
                              line.binSpanningInfo.length > 1 && (
                                <div className="mt-1 pt-1 border-t border-border/50">
                                  <div className="text-muted-foreground mb-0.5">
                                    {t("table.bin.spanning", {
                                      defaultValue:
                                        "Recipe split across {{count}} bin shapes:",
                                      count: line.binSpanningInfo.length,
                                    })}
                                  </div>
                                  <ul className="ml-3 text-muted-foreground list-disc">
                                    {line.binSpanningInfo.map((entry) => (
                                      <li key={entry.binId}>
                                        {formatCount(entry.slots, ceilMode)}{" "}
                                        {t("table.bin.slotsRaw", {
                                          defaultValue: "slots",
                                        })}{" "}
                                        ({formatCount(entry.buildingCount, ceilMode)}{" "}
                                        {t("table.bin.buildings", {
                                          defaultValue: "buildings",
                                        })}
                                        )
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      formatCount(line.facilityCount, ceilMode)
                    )}
                  </TableCell>

                  {/* Recipe - hide when manually marked as raw material */}
                  <TableCell className="p-2">
                    {line.isRawMaterial ? (
                      <div className="text-xs text-muted-foreground">
                        {t("table.rawMaterial")}
                      </div>
                    ) : isManualRaw ? (
                      <div className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                        {t("table.manualRawMaterial")}
                      </div>
                    ) : line.availableRecipes.length > 1 ? (
                      <div className="flex items-center gap-1">
                        <Select
                          value={line.selectedRecipeId}
                          onValueChange={(value: RecipeId) =>
                            onRecipeChange(line.item.id, value)
                          }
                        >
                          <SelectTrigger className="h-auto min-h-8 text-xs py-1">
                            <SelectValue>
                              {selectedRecipe && (
                                <RecipeIOCompact
                                  recipe={selectedRecipe}
                                  getItemById={getItemById}
                                />
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent className="max-w-[400px]">
                            {line.availableRecipes.map((recipe) => (
                              <SelectItem
                                key={recipe.id}
                                value={recipe.id}
                                className="text-xs"
                              >
                                <div className="flex flex-col gap-1 py-1">
                                  <span className="font-medium text-xs">
                                    {getRecipeName(recipe)}
                                  </span>
                                  <RecipeIOFull
                                    recipe={recipe}
                                    getItemById={getItemById}
                                  />
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {/*
                         * Mixed-strategy hint: when the LP returns >1
                         * active producer for this item, show "+N more"
                         * next to the dominant formula. Hover surfaces
                         * the full breakdown with per-formula facility
                         * counts. Clicking a formula in the dropdown
                         * narrows the LP to that single choice (via the
                         * existing pin mechanism).
                         *
                         * Currently dormant on live data — HiGHS simplex
                         * lands on vertex solutions; mixed strategies
                         * would only materialise under future raw-cap
                         * features (see flow-solver:detectMixedStrategies).
                         */}
                        {line.activeProducers &&
                          line.activeProducers.length > 1 && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help text-[10px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded px-1.5 py-0.5">
                                  {t("table.recipe.mixedHint", {
                                    count: line.activeProducers.length - 1,
                                    defaultValue: "+{{count}} more",
                                  })}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="left" className="max-w-[320px]">
                                <div className="text-xs">
                                  <div className="font-medium mb-2">
                                    {t("table.recipe.mixedTooltipHeader", {
                                      defaultValue:
                                        "This item is produced by multiple formulas:",
                                    })}
                                  </div>
                                  <ul className="space-y-1">
                                    {line.activeProducers.map((p) => {
                                      const recipe = line.availableRecipes.find(
                                        (r) => r.id === p.recipeId,
                                      );
                                      if (!recipe) return null;
                                      return (
                                        <li key={p.recipeId} className="flex items-center justify-between gap-2">
                                          <span>{getRecipeName(recipe)}</span>
                                          <span className="text-muted-foreground font-mono">
                                            {formatNumber(p.facilityCount, 2)}{" "}
                                            {t("table.bin.buildings", {
                                              defaultValue: "buildings",
                                            })}
                                          </span>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          )}
                      </div>
                    ) : selectedRecipe ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="cursor-help">
                            <RecipeIOCompact
                              recipe={selectedRecipe}
                              getItemById={getItemById}
                            />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="max-w-[300px]">
                          <div className="text-xs">
                            <div className="font-medium mb-2">
                              {getRecipeName(selectedRecipe)}
                            </div>
                            <RecipeIOFull
                              recipe={selectedRecipe}
                              getItemById={getItemById}
                            />
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        {t("table.noRecipe")}
                      </div>
                    )}
                  </TableCell>

                  {/* Total power — bin-aware: only the bin's primary row
                   * shows power; other co-located rows show "(grouped)".
                   * Sums across rows match plan-level total exactly. */}
                  <TableCell className="text-right font-mono text-sm tabular-nums p-2">
                    {line.isRawMaterial || isManualRaw ? (
                      <span className="text-muted-foreground">-</span>
                    ) : isGrouped && !line.isBinPrimary ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-muted-foreground italic text-xs cursor-help">
                            {t("table.bin.grouped", {
                              defaultValue: "grouped",
                            })}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="left">
                          <p className="text-xs">
                            {t("table.bin.powerSharedExplain", {
                              defaultValue:
                                "Power counted on the bin's primary row.",
                            })}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span>{formatNumber(totalPower, 0)}</span>
                    )}
                  </TableCell>

                  {/* Raw material toggle */}
                  <TableCell className="p-2">
                    <div className="flex justify-center">
                      {!line.isTarget &&
                        !line.isDisposal &&
                        !(line.isRawMaterial && !line.isManualRawMaterial) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div>
                                <Switch
                                  checked={line.isManualRawMaterial}
                                  onCheckedChange={() =>
                                    onToggleRawMaterial(line.item.id)
                                  }
                                  className="data-[state=checked]:bg-blue-500"
                                />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              {line.isManualRawMaterial ? (
                                <p className="text-xs">
                                  {t("table.unmarkRawMaterial")}
                                </p>
                              ) : (
                                <p className="text-xs">
                                  {t("table.markAsRawMaterial")}
                                </p>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      {data.length > 0 && (
        <div className="border-t bg-muted/20 px-4 py-2 flex items-center justify-end gap-6 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {t("table.totals.buildings", { defaultValue: "Total buildings" })}:
            </span>
            <span className="font-mono font-semibold tabular-nums">
              {totals.totalBuildings}
            </span>
            {totals.groupedSavings > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-purple-700 dark:text-purple-400 cursor-help text-[10px]">
                    (−{totals.groupedSavings}{" "}
                    {t("table.totals.viaGrouping", {
                      defaultValue: "via grouping",
                    })}
                    )
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[280px]">
                  <p className="text-xs">
                    {t("table.totals.savingsExplain", {
                      defaultValue:
                        "Buildings saved by packing recipes into shared multi-formula buildings.",
                    })}
                  </p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {t("table.totals.power", { defaultValue: "Total power" })}:
            </span>
            <span className="font-mono font-semibold tabular-nums">
              {formatNumber(totals.totalPower, 0)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
});

export default ProductionTable;
export { ItemIcon, RecipeIOFull };
