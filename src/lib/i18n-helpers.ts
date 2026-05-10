import i18next from "@/i18n";
import type { Item, Facility, Recipe, RecipeId } from "@/types";
import { getTransportCapacity } from "./utils";

export const getItemName = (item: Item) => {
  return i18next.t(item.id, { ns: "item", defaultValue: item.id });
};

export const getTransportLabel = (item?: Item) => {
  return item?.isLiquid
    ? i18next.t("pipe.pipes", { ns: "production" })
    : i18next.t("belt.belts", { ns: "production" });
};

/**
 * Label for an "internal" flow edge (producer and consumer co-located
 * in the same multi-formula building). Replaces the belt/pipe count
 * since no transport is needed.
 */
export const getInternalFlowLabel = () => {
  return i18next.t("transport.internal", {
    ns: "production",
    defaultValue: "internal",
  });
};

export const getTransportTooltip = (item?: Item) => {
  const capacity = getTransportCapacity(item);
  return item?.isLiquid
    ? i18next.t("pipe.tooltip", { ns: "production", pipe_rate: capacity })
    : i18next.t("belt.tooltip", { ns: "production", belt_rate: capacity });
};

export const getFacilityName = (facility: Facility) => {
  return i18next.t(facility.id, {
    ns: "facility",
    defaultValue: facility.id,
  });
};

/**
 * Resolves a recipe's display name. Falls back to the raw RecipeId when no
 * translation exists (e.g. synthetic disposal recipes that have no game
 * name). Accepts either a Recipe object or just a RecipeId so callers
 * without the full recipe data (e.g. tooltip listing sister recipes by id)
 * can still resolve names.
 */
export const getRecipeName = (recipeOrId: Recipe | RecipeId) => {
  const id = typeof recipeOrId === "string" ? recipeOrId : recipeOrId.id;
  return i18next.t(id, { ns: "recipe", defaultValue: id });
};
