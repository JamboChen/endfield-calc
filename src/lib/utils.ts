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

import type { Item } from "@/types";

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

export const getPickupPointCount = (demandRate: number, item?: Item): number =>
  demandRate > 0 ? Math.ceil(demandRate / getTransportCapacity(item)) : 0;

/**
 * Formats a count value for display.
 * When ceilMode is true, shows integers. Otherwise shows 1 decimal place.
 */
export const formatCount = (value: number, ceilMode = false): string =>
  value.toFixed(ceilMode ? 0 : 1);
