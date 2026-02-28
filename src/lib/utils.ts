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

export const TRANSPORT_BELT_CAPACITY = 30;

export const getBeltCount = (itemsPerMinute: number): number =>
  itemsPerMinute / TRANSPORT_BELT_CAPACITY;

export const getPickupPointCount = (demandRate: number): number =>
  demandRate > 0 ? Math.ceil(demandRate / TRANSPORT_BELT_CAPACITY) : 0;
