import i18next from "@/i18n";
import type { Item, Facility } from "@/types";
import { getTransportCapacity } from "./utils";

export const getItemName = (item: Item) => {
  return i18next.t(item.id, { ns: "item", defaultValue: item.id });
};

export const getTransportLabel = (item?: Item) => {
  return item?.isLiquid
    ? i18next.t("pipe.pipes", { ns: "production" })
    : i18next.t("belt.belts", { ns: "production" });
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
