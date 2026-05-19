import { useMemo } from "react";
import type {
  Facility,
  FacilityId,
  Item,
  ItemId,
  ProductionDependencyGraph,
} from "@/types";
import { aggregateBinTotals } from "@/lib/plan-helpers";
import { getItemById, getPickupPointCount, getRawSourceRate } from "@/lib/utils";

export type ProductionStats = {
  totalPowerConsumption: number;
  rawMaterialRequirements: Map<ItemId, number>;
  uniqueProductionSteps: number;
  facilityRequirements: Map<FacilityId, number>;
  /**
   * Total pickup-point count summed across all raws. **Fractional** —
   * apply `formatCount(value, ceilMode)` at the display site to render
   * either the ceiled physical count or the fractional theoretical view.
   */
  totalPickupPoints: number;
  /**
   * Per-raw fractional pickup count. Display sites format via
   * `formatCount(value, ceilMode)`.
   */
  rawMaterialPickupPoints: Map<ItemId, number>;
};

/**
 * Collects statistics from the production graph. Bin-level aggregates
 * (power, per-facility counts) come from `aggregateBinTotals`, the
 * single source of truth shared with `useProductionTable`. Item-level
 * counts (raw materials, unique production steps) are computed locally
 * from `plan.nodes`.
 *
 * `ceilMode` toggles physical (whole buildings + full power per built
 * building) vs theoretical (fractional buildings + proportional power)
 * accounting; passed straight through to `aggregateBinTotals`.
 */
function collectStats(
  plan: ProductionDependencyGraph,
  manualRawMaterials: Set<ItemId>,
  facilities: Facility[],
  items: Item[],
  ceilMode: boolean,
): ProductionStats {
  const rawMaterials = new Map<ItemId, number>();
  let uniqueProductionSteps = 0;

  plan.nodes.forEach((node) => {
    if (node.type !== "item") return;
    if (node.isRawMaterial || manualRawMaterials.has(node.itemId)) {
      rawMaterials.set(
        node.itemId,
        (rawMaterials.get(node.itemId) || 0) + node.productionRate,
      );
    } else if (node.productionRate > 0) {
      uniqueProductionSteps++;
    }
  });

  const { totalPower, perFacility } = aggregateBinTotals(
    plan,
    facilities,
    items,
    { ceilMode },
  );

  const rawMaterialPickupPoints = new Map<ItemId, number>();
  let totalPickupPoints = 0;
  rawMaterials.forEach((rate, itemId) => {
    const item = getItemById(items, itemId);
    const count = getPickupPointCount(rate, getRawSourceRate(itemId, item));
    rawMaterialPickupPoints.set(itemId, count);
    totalPickupPoints += count;
  });

  return {
    totalPowerConsumption: totalPower,
    rawMaterialRequirements: rawMaterials,
    uniqueProductionSteps,
    facilityRequirements: perFacility,
    totalPickupPoints,
    rawMaterialPickupPoints,
  };
}

/**
 * Hook to calculate production statistics from the plan.
 *
 * Bin-level numbers (power, per-facility counts) come from the shared
 * `aggregateBinTotals` helper, so they always agree with the table
 * footer that `useProductionTable` exposes. The previous
 * per-recipe-ceiled aggregation triple-counted shared multi-formula
 * bins (e.g. an Xircon `{LX,XE,X}` bin showing 3 Expanded instead of 1).
 *
 * `ceilMode` toggles the rounding semantic — see `aggregateBinTotals`.
 */
export function useProductionStats(
  plan: ProductionDependencyGraph | null,
  manualRawMaterials: Set<ItemId>,
  facilities: Facility[],
  items: Item[],
  ceilMode: boolean,
): ProductionStats {
  return useMemo(() => {
    if (!plan || plan.nodes.size === 0) {
      return {
        totalPowerConsumption: 0,
        rawMaterialRequirements: new Map(),
        uniqueProductionSteps: 0,
        facilityRequirements: new Map(),
        totalPickupPoints: 0,
        rawMaterialPickupPoints: new Map(),
      };
    }

    return collectStats(plan, manualRawMaterials, facilities, items, ceilMode);
  }, [plan, manualRawMaterials, facilities, items, ceilMode]);
}
