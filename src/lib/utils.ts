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

import type { Item, ItemId } from "@/types";
import { rawMaterialSources } from "@/data";

const TRANSPORT_BELT_CAPACITY = 30;
const TRANSPORT_PIPE_CAPACITY = 120;

/**
 * Absolute tolerance (in transport units) absorbed before ceiling.
 * Per-building rates carry float noise (e.g. 30.000000000000004/min from
 * `rate / fullLoadFraction * loadFraction`), which would otherwise ceil a
 * one-belt 30/min edge to 2 belts.
 */
const TRANSPORT_COUNT_TOLERANCE = 1e-9;

/** Liquids AND gases (1.4+) travel through pipes; solids ride belts. */
export const getTransportCapacity = (item?: Item): number =>
  item?.isLiquid || item?.isGas
    ? TRANSPORT_PIPE_CAPACITY
    : TRANSPORT_BELT_CAPACITY;

export const getTransportCount = (
  itemsPerMinute: number,
  item?: Item,
  ceil = false,
): number => {
  const count = itemsPerMinute / getTransportCapacity(item);
  return ceil ? Math.max(Math.ceil(count - TRANSPORT_COUNT_TOLERANCE), 0) : count;
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

/**
 * Per-facility throughput for the source building that supplies a raw
 * material. Honours the `ratePerMinute` override from `rawMaterialSources`
 * (60/min for liquids — pump_1/pump_2 cap at one unit per second;
 * 20/min for gases — gas_pump_1 extracts one unit per 3 s).
 * Falls back to transport capacity (30 belt / 120 pipe) for raws without
 * an explicit override, and for items that aren't in `rawMaterialSources`
 * (defensive — shouldn't happen for actual raws).
 */
export const getRawSourceRate = (
  itemId: ItemId,
  item: Item | undefined,
): number => {
  const cfg = rawMaterialSources.get(itemId);
  return cfg?.ratePerMinute ?? getTransportCapacity(item);
};

/**
 * Fractional number of source-facility instances (pickup points) needed
 * to supply the demand. Returns the raw `demand / perFacilityRate` ratio
 * — callers apply `formatCount(value, ceilMode)` (or similar) to render
 * either the ceiled physical count (ceilMode=true) or the fractional
 * theoretical count (ceilMode=false). Mirrors how regular bin facility
 * counts are formatted.
 *
 * `perFacilityRate` is the per-facility throughput from `getRawSourceRate`
 * — DO NOT pass transport capacity directly: pumps (60/min) are slower
 * than pipes (120/min) and unloaders (30/min) match belt capacity, but
 * the source-rate abstraction is the right concept.
 */
export const getPickupPointCount = (
  demandRate: number,
  perFacilityRate: number,
): number =>
  demandRate > 0 && perFacilityRate > 0 ? demandRate / perFacilityRate : 0;

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
  (ceilMode ? Math.ceil(value) : value).toFixed(ceilMode ? 0 : 1);

/**
 * Formats a number for display with a fixed number of decimal places.
 */
export const formatNumber = (num: number, decimals = 2): string =>
  num.toFixed(decimals);

/**
 * Looks up an item by its ID from an items array.
 */
export const getItemById = (
  items: readonly Item[],
  itemId: ItemId,
): Item | undefined => items.find((i) => i.id === itemId);


