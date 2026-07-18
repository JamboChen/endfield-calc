import i18next from "@/i18n";
import type { DomainId, Item, Facility, Recipe, RecipeId } from "@/types";
import { getTransportCapacity } from "./utils";

export const getDomainName = (domainId: DomainId) => {
  return i18next.t(`domains.${domainId}.name`, {
    ns: "domain",
    defaultValue: domainId,
  });
};

export const getItemName = (item: Item) => {
  return i18next.t(item.id, { ns: "item", defaultValue: item.id });
};

export const getRecipeName = (recipeOrId: Recipe | RecipeId) => {
  const id = typeof recipeOrId === "string" ? recipeOrId : recipeOrId.id;
  return i18next.t(id, { ns: "recipe", defaultValue: id });
};

export const getTransportLabel = (item?: Item) => {
  return item?.isLiquid || item?.isGas
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
  return item?.isLiquid || item?.isGas
    ? i18next.t("pipe.tooltip", { ns: "production", pipe_rate: capacity })
    : i18next.t("belt.tooltip", { ns: "production", belt_rate: capacity });
};

export const getFacilityName = (facility: Facility) => {
  return i18next.t(facility.id, {
    ns: "facility",
    defaultValue: facility.id,
  });
};
