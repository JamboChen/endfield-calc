import { useMemo } from "react";
import type {
  Facility,
  FacilityId,
  Item,
  ItemId,
  ProductionDependencyGraph,
} from "@/types";
import type { BinAggregates } from "@/lib/plan-helpers";
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
 * (power, per-facility counts) come from the shared `BinAggregates`
 * computed once in `useProductionPlan` and threaded down. Item-level
 * counts (raw materials, unique production steps) are computed locally
 * from `plan.nodes`.
 *
 * The `aggregates` arg is the single canonical aggregate per render;
 * it carries both display-adjusted (`perFacility`) and raw
 * (`rawPerFacility`) per-facility maps. Stats reads the display one.
 */
function collectStats(
  plan: ProductionDependencyGraph,
  aggregates: BinAggregates,
  manualRawMaterials: Set<ItemId>,
  items: Item[],
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

  const { totalPower, perFacility } = aggregates;

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
 * `BinAggregates` lifted into `useProductionPlan`, so they always
 * agree with the table footer that `useProductionTable` exposes. The
 * previous per-recipe-ceiled aggregation triple-counted shared
 * multi-formula bins (e.g. an Xircon `{LX,XE,X}` bin showing 3
 * Expanded instead of 1); the shared aggregate prevents drift.
 *
 * `facilities` and `ceilMode` remain in the signature for backwards
 * compatibility with callers, but the heavy lift is now done once
 * upstream in `useProductionPlan` and passed via `aggregates`.
 */
export function useProductionStats(
  plan: ProductionDependencyGraph | null,
  aggregates: BinAggregates | null,
  manualRawMaterials: Set<ItemId>,
  facilities: Facility[],
  items: Item[],
  ceilMode: boolean,
): ProductionStats {
  // facilities + ceilMode kept on the signature: future stats fields
  // may need them, and keeping them avoids a churn of call sites if
  // such fields are added. Reference them here so unused-param lints
  // don't fire.
  void facilities;
  void ceilMode;
  return useMemo(() => {
    if (!plan || plan.nodes.size === 0 || !aggregates) {
      return {
        totalPowerConsumption: 0,
        rawMaterialRequirements: new Map(),
        uniqueProductionSteps: 0,
        facilityRequirements: new Map(),
        totalPickupPoints: 0,
        rawMaterialPickupPoints: new Map(),
      };
    }

    return collectStats(plan, aggregates, manualRawMaterials, items);
  }, [plan, aggregates, manualRawMaterials, items]);
}
