import { useMemo } from "react";
import type {
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
  /**
   * Per-facility cap-overflow info. Keys are facility ids of facilities
   * whose plan demand exceeds the user's configured AIC cap; values
   * carry the raw LP-derived `used` count and the integer `cap`.
   *
   * Threaded through from `useProductionPlan` (single source of truth
   * — same data populates the warnings string array). Consumed by
   * `<ProductionStats>` to apply destructive styling + tooltip on
   * over-cap facility cards. Empty when no facility is over cap.
   */
  facilityOverCapMap: ReadonlyMap<FacilityId, { used: number; cap: number }>;
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
 *
 * `facilityOverCapMap` is a pass-through from `useProductionPlan` —
 * stats doesn't transform it, just bundles it into the returned shape
 * so the side panel reads everything from one cohesive object.
 */
function collectStats(
  plan: ProductionDependencyGraph,
  aggregates: BinAggregates,
  facilityOverCapMap: ReadonlyMap<FacilityId, { used: number; cap: number }>,
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
    facilityOverCapMap,
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
 * `items` is needed to resolve per-item source-facility rates (pumps
 * vs. depots) for pickup-point counts; everything else flows through
 * the shared `aggregates`.
 */
export function useProductionStats(
  plan: ProductionDependencyGraph | null,
  aggregates: BinAggregates | null,
  facilityOverCapMap: ReadonlyMap<FacilityId, { used: number; cap: number }>,
  manualRawMaterials: Set<ItemId>,
  items: Item[],
): ProductionStats {
  return useMemo(() => {
    if (!plan || plan.nodes.size === 0 || !aggregates) {
      return {
        totalPowerConsumption: 0,
        rawMaterialRequirements: new Map(),
        uniqueProductionSteps: 0,
        facilityRequirements: new Map(),
        totalPickupPoints: 0,
        rawMaterialPickupPoints: new Map(),
        facilityOverCapMap: new Map(),
      };
    }

    return collectStats(plan, aggregates, facilityOverCapMap, manualRawMaterials, items);
  }, [plan, aggregates, facilityOverCapMap, manualRawMaterials, items]);
}
