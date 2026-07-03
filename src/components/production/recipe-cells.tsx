/**
 * Shared production-line cell components, extracted from
 * `ProductionTable` so the portrait card view (`ProductionCards`) and
 * the flow-node components render the exact same visual language:
 * item icons, compact/full recipe I/O visualisations, the facility
 * icon cell, the pin-reset affordance, and the recipe-picker Select.
 */
import { memo } from "react";
import { RotateCcw } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import type { Facility, Item, ItemId, Recipe, RecipeId } from "@/types";
import { useTranslation } from "react-i18next";
import { getFacilityName, getItemName, getRecipeName } from "@/lib/i18n-helpers";
import { FacilityIcon } from "@/components/FacilityIcon";

const sizeClasses = {
  sm: { icon: "h-4 w-4 object-contain inline-block", fallback: "inline-block w-4 h-4 bg-muted rounded text-[5px] text-center leading-4" },
  md: { icon: "h-8 w-8 object-contain inline-block", fallback: "inline-block w-8 h-8 bg-muted rounded text-[7px] text-center leading-3" },
} as const;

export const ItemIcon = memo(({ item, size = "md" }: { item: Item; size?: "sm" | "md" }) => {
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

export const RecipeIOCompact = memo(
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

export const RecipeIOFull = memo(
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

export const FacilityIconCell = memo(
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
            <FacilityIcon
              facility={facility}
              alt={facilityName}
              className="h-8 w-8 object-contain"
            />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">{facilityName}</p>
        </TooltipContent>
      </Tooltip>
    );
  },
);

FacilityIconCell.displayName = "FacilityIconCell";

/**
 * Small icon-button rendered in front of a recipe picker whenever the
 * row's item carries a user pin (`recipeOverrides.has(itemId)`).
 * Clicking it dispatches `onRecipePinReset(itemId)` which deletes the
 * pin via `useProductionPlan.handleRecipePinReset` and triggers a
 * recompute — the LP then re-picks the producer freely.
 *
 * Same button is used on ghost rows; ghost rows always have a pin so
 * the affordance is always visible there.
 */
export const ResetPinButton = memo(
  ({
    itemId,
    onReset,
    label,
  }: {
    itemId: ItemId;
    onReset: (id: ItemId) => void;
    label: string;
  }) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => onReset(itemId)}
          aria-label={label}
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-xs">{label}</p>
      </TooltipContent>
    </Tooltip>
  ),
);

ResetPinButton.displayName = "ResetPinButton";

/**
 * The recipe-picker Select shared by normal table rows, ghost rows and
 * the portrait cards: trigger shows the selected recipe's compact I/O;
 * options show recipe name + full I/O. Selecting pins the recipe as
 * the item's SOLE producer (see the mixed-strategy commentary at the
 * table call site). The pin-reset affordance is composed by callers —
 * its placement rules differ per surface.
 */
export const RecipeSelect = memo(
  ({
    itemId,
    availableRecipes,
    selectedRecipeId,
    onRecipeChange,
    getItemById,
  }: {
    itemId: ItemId;
    availableRecipes: readonly Recipe[];
    selectedRecipeId: RecipeId | "";
    onRecipeChange: (itemId: ItemId, recipeId: RecipeId) => void;
    getItemById: (id: ItemId) => Item | undefined;
  }) => {
    const selectedRecipe = availableRecipes.find(
      (r) => r.id === selectedRecipeId,
    );
    return (
      <Select
        value={selectedRecipeId}
        onValueChange={(value: RecipeId) => onRecipeChange(itemId, value)}
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
          {availableRecipes.map((recipe) => (
            <SelectItem key={recipe.id} value={recipe.id} className="text-xs">
              <div className="flex flex-col gap-1 py-1">
                <span className="font-medium text-xs">
                  {getRecipeName(recipe)}
                </span>
                <RecipeIOFull recipe={recipe} getItemById={getItemById} />
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  },
);

RecipeSelect.displayName = "RecipeSelect";
