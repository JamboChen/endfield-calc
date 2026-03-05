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
import type { Item, Recipe, Facility, ItemId, RecipeId } from "@/types";
import { useTranslation } from "react-i18next";
import { getBeltTooltip, getFacilityName, getItemName } from "@/lib/i18n-helpers";
import { getBeltCount, getPickupPointCount, TRANSPORT_BELT_CAPACITY } from "@/lib/utils";

export type ProductionLineData = {
  item: Item;
  outputRate: number;
  availableRecipes: Recipe[];
  selectedRecipeId: RecipeId | "";
  facility: Facility | null;
  facilityCount: number;
  isRawMaterial?: boolean;
  isTarget?: boolean;
  isManualRawMaterial?: boolean;
  directDependencyItemIds?: Set<ItemId>;
};

type ProductionTableProps = {
  data: ProductionLineData[];
  items: Item[];
  facilities: Facility[];
  onRecipeChange: (itemId: ItemId, recipeId: RecipeId) => void;
  onToggleRawMaterial: (itemId: ItemId) => void;
  ceilMode?: boolean;
};

const formatNumber = (num: number, decimals = 2): string => {
  return num.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

const ItemIcon = memo(({ item }: { item: Item }) => {
  const itemName = getItemName(item);

  if (item.iconUrl) {
    return (
      <img
        src={item.iconUrl}
        alt={itemName}
        className="h-8 w-8 object-contain inline-block"
      />
    );
  }

  return (
    <span className="inline-block w-8 h-8 bg-muted rounded text-[7px] text-center leading-3">
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
                colSpan={9}
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
              const totalPower = line.facility?.powerConsumption
                ? line.facility.powerConsumption * line.facilityCount
                : 0;

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
              if (line.isTarget) {
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
                  key={line.item.id}
                  className={[
                    rowClassName,
                    shouldDim && "opacity-30",
                    isHovered && "ring-2 ring-inset ring-blue-500/60 shadow-sm",
                    isDependency && "ring-1 ring-inset ring-green-500/40",
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
                      line.isTarget &&
                        "before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:bg-amber-500",
                      isManualRaw &&
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

                  {/* Belts */}
                  <TableCell className="text-right font-mono text-sm tabular-nums p-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex flex-col items-end cursor-help">
                          <span>{formatNumber(getBeltCount(line.outputRate, ceilMode), ceilMode ? 0 : 1)}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {t("belt.belts")}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          {getBeltTooltip(TRANSPORT_BELT_CAPACITY)}
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
                    {line.isRawMaterial ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-green-600 dark:text-green-400 cursor-help">
                            {getPickupPointCount(line.outputRate)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs">{t("tree.pickupPoint")}</p>
                        </TooltipContent>
                      </Tooltip>
                    ) : isManualRaw ? (
                      <span className="text-muted-foreground">-</span>
                    ) : (
                      formatNumber(line.facilityCount, 1)
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
                                  {recipe.id}
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
                              {selectedRecipe.id}
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

                  {/* Total power */}
                  <TableCell className="text-right font-mono text-sm tabular-nums p-2">
                    {line.isRawMaterial || isManualRaw ? (
                      <span className="text-muted-foreground">-</span>
                    ) : (
                      <span>{formatNumber(totalPower, 0)}</span>
                    )}
                  </TableCell>

                  {/* Raw material toggle */}
                  <TableCell className="p-2">
                    <div className="flex justify-center">
                      {!line.isTarget &&
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
    </div>
  );
});

export default ProductionTable;
export { ItemIcon, RecipeIOFull };
