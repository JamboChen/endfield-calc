import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Calculates the production rate (per minute).
 * @param amount Amount produced per craft
 * @param craftingTime Time to craft in seconds
 */
export const calcRate = (amount: number, craftingTime: number): number =>
  (amount * 60) / craftingTime;

import type { Item, ItemId, Recipe } from "@/types";

export const TRANSPORT_BELT_CAPACITY = 30;
export const TRANSPORT_PIPE_CAPACITY = 120;

export const getTransportCapacity = (item?: Item): number =>
  item?.isLiquid ? TRANSPORT_PIPE_CAPACITY : TRANSPORT_BELT_CAPACITY;

export const getTransportCount = (
  itemsPerMinute: number,
  item?: Item,
  ceil = false,
): number => {
  const count = itemsPerMinute / getTransportCapacity(item);
  return ceil ? Math.ceil(count) : count;
};

/**
 * Facility-aware transport count: accounts for the fact that each building
 * has its own output port and needs its own transport connection.
 * Returns max(throughput-based count, facilityCount).
 */
export const getTransportCountWithFacilities = (
  itemsPerMinute: number,
  item: Item | undefined,
  ceil: boolean,
  facilityCount: number,
): number => {
  const throughput = getTransportCount(itemsPerMinute, item, ceil);
  return ceil ? Math.max(throughput, Math.ceil(facilityCount)) : Math.max(throughput, facilityCount);
};

export const getPickupPointCount = (demandRate: number, item?: Item): number =>
  demandRate > 0 ? Math.ceil(demandRate / getTransportCapacity(item)) : 0;

/**
 * Returns the effective facility count — ceiled when ceilMode is on,
 * since each physical building exists as a whole unit.
 */
export const getEffectiveFacilityCount = (
  facilityCount: number,
  ceilMode: boolean,
): number => (ceilMode ? Math.ceil(facilityCount) : facilityCount);

/**
 * Formats a count value for display.
 * When ceilMode is true, shows integers. Otherwise shows 1 decimal place.
 */
export const formatCount = (value: number, ceilMode = false): string =>
  value.toFixed(ceilMode ? 0 : 1);

/**
 * Formats a number for display with a fixed number of decimal places.
 */
export const formatNumber = (num: number, decimals = 2): string =>
  num.toFixed(decimals);

/**
 * Looks up an item by its ID from an items array.
 */
export const getItemById = (items: Item[], itemId: ItemId): Item | undefined =>
  items.find((i) => i.id === itemId);

/**
 * Gets the output amount for a specific item from a recipe.
 * Falls back to the first output's amount if the item is not found.
 */
export const getOutputAmount = (recipe: Recipe, itemId: ItemId): number =>
  recipe.outputs.find((o) => o.itemId === itemId)?.amount ??
  recipe.outputs[0]?.amount ??
  1;

/**
 * Computes the byproduct rate for a facility instance based on the
 * primary output's actual rate and the recipe's output amounts.
 */
export const calcByproductRate = (
  recipe: Recipe,
  byproductItemId: ItemId,
  facilityOutputRate: number,
): number => {
  const primaryOutput = recipe.outputs[0];
  const byproductOutput = recipe.outputs.find(
    (o) => o.itemId === byproductItemId,
  );
  if (!primaryOutput || !byproductOutput) return 0;
  return (
    calcRate(byproductOutput.amount, recipe.craftingTime) *
    (facilityOutputRate /
      calcRate(primaryOutput.amount, recipe.craftingTime))
  );
};
