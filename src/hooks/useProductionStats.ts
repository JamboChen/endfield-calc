import { useMemo } from "react";
import type {
  Facility,
  FacilityId,
  Item,
  ItemId,
  PlanMetastorageImport,
  ProductionDependencyGraph,
} from "@/types";
import type { BinAggregates } from "@/lib/plan-helpers";
import {
  calcRate,
  getItemById,
  getPickupPointCount,
  getRawSourceRate,
} from "@/lib/utils";
import { facilities, rawMaterialSources } from "@/data";
import { PUMP_CATEGORIES } from "@/lib/plan-helpers";

export type ProductionStats = {
  totalPowerConsumption: number;
  rawMaterialRequirements: Map<ItemId, number>;
  uniqueProductionSteps: number;
  facilityRequirements: Map<FacilityId, number>;
  /**
   * Σ effective buildings (bins + pickup sources) from
   * `aggregates.totalBuildings`. ceilMode-adjusted upstream —
   * fractional in the theoretical view; format via
   * `formatCount(value, ceilMode)` at the display site.
   */
  totalBuildings: number;
  /**
   * Σ Core-AIC build-grid tiles (`aggregates.totalTiles`). Always a
   * whole number (buildings occupy whole tiles in either view mode); a
   * lower bound — belts/pipes aren't modelable. Pumps and map-placed
   * structures excluded (they live outside the build grid).
   */
  totalTiles: number;
  /**
   * Physical multi-formula buildings saved by grouping vs the
   * one-recipe-one-building baseline. Same derivation as the table
   * footer (`max(0, baseline − actual)`).
   */
  groupedSavings: number;
  /**
   * Mode-independent raw LP per-facility counts
   * (`aggregates.rawPerFacility`). Drives the utilization subline on
   * facility cards: `raw ÷ ceil(raw)` is the fraction of built capacity
   * the plan actually uses.
   */
  rawFacilityRequirements: ReadonlyMap<FacilityId, number>;
  /**
   * Total pickup-point count summed across all raws. **Fractional** —
   * apply `formatCount(value, ceilMode)` at the display site to render
   * either the ceiled physical count or the fractional theoretical view.
   */
  totalPickupPoints: number;
  /**
   * Depot-side pickup points (Depot Unloaders — the depot-bus slots
   * that are the community-consensus hard throughput cap). Fractional;
   * format via `formatCount`. `totalPickupPoints = depot + pump`.
   */
  depotPickupPoints: number;
  /**
   * Open-world pump deployments (Fluid Pump / Acid Pump). Kept separate
   * from depot ports — pumps sit on fluid bodies and consume no depot
   * bus slot. Fractional; format via `formatCount`.
   */
  pumpPickupPoints: number;
  /**
   * Per-raw fractional pickup count. Display sites format via
   * `formatCount(value, ceilMode)`.
   */
  rawMaterialPickupPoints: Map<ItemId, number>;
  /**
   * Byproduct disposal flows: items consumed by `isDisposal` recipe
   * nodes (Sewage Inlet / Water Treatment sinks), with the summed
   * disposal rate per item in items/min. Sorted by rate descending.
   * Empty when the plan disposes of nothing.
   */
  disposal: { item: Item; ratePerMinute: number }[];
  /**
   * Metastorage transfer routes the calculator chose
   * (`plan.metastorageImports` pass-through). Empty when no route is
   * active.
   */
  metastorageImports: readonly PlanMetastorageImport[];
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

/** Facility ids whose category marks them as open-world pumps. */
const pumpFacilityIds: ReadonlySet<FacilityId> = new Set(
  facilities.filter((f) => PUMP_CATEGORIES.has(f.category)).map((f) => f.id),
);

/**
 * Comparator factory for facility-requirement rows: over-cap rows
 * pinned first, then heaviest builds by the **mode-independent** raw LP
 * counts (`rawFacilityRequirements`), id tiebreak for stability.
 *
 * Sorting on the raw counts — not the ceilMode-adjusted display counts —
 * keeps row order identical when the user toggles "Round up
 * facilities": ceiling is applied per bin, so display counts collapse
 * crossings into ties and let many-partial-bin facilities leapfrog,
 * reshuffling the grid on what is merely a display preference. The raw
 * counts are continuous, so the order (and the layout) stays put.
 *
 * Shared by `BottomDock` and the portrait `ProductionStats` card so the
 * two surfaces order identically.
 */
export function compareFacilityRows(
  overCapMap: ReadonlyMap<FacilityId, { used: number; cap: number }>,
  rawCounts: ReadonlyMap<FacilityId, number>,
): (
  a: { facility: Facility; count: number },
  b: { facility: Facility; count: number },
) => number {
  return (a, b) => {
    const aOver = overCapMap.has(a.facility.id) ? 1 : 0;
    const bOver = overCapMap.has(b.facility.id) ? 1 : 0;
    if (aOver !== bOver) return bOver - aOver;
    const aRaw = rawCounts.get(a.facility.id) ?? a.count;
    const bRaw = rawCounts.get(b.facility.id) ?? b.count;
    if (aRaw !== bRaw) return bRaw - aRaw;
    return a.facility.id.localeCompare(b.facility.id);
  };
}

/**
 * Collects statistics from the production graph. Bin-level aggregates
 * (power, buildings, tiles, per-facility counts) come from the shared
 * `BinAggregates` computed once in `useProductionPlan` and threaded
 * down. Item-level counts (raw materials, unique production steps,
 * pickup-point split, disposal flows) are computed locally from
 * `plan.nodes`.
 *
 * The `aggregates` arg is the single canonical aggregate per render;
 * it carries both display-adjusted (`perFacility`) and raw
 * (`rawPerFacility`) per-facility maps. Stats forwards both — the raw
 * map drives the utilization subline on facility cards.
 *
 * `facilityOverCapMap` is a pass-through from `useProductionPlan` —
 * stats doesn't transform it, just bundles it into the returned shape
 * so the panels read everything from one cohesive object.
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
  const disposalByItem = new Map<ItemId, number>();

  plan.nodes.forEach((node) => {
    if (node.type === "recipe") {
      // Disposal sinks: rate = input consumption × facility count.
      if (node.isDisposal && node.recipe.inputs.length > 0) {
        const input = node.recipe.inputs[0];
        const rate =
          calcRate(input.amount, node.recipe.craftingTime) *
          node.facilityCount;
        disposalByItem.set(
          input.itemId,
          (disposalByItem.get(input.itemId) ?? 0) + rate,
        );
      }
      return;
    }
    if (node.isRawMaterial || manualRawMaterials.has(node.itemId)) {
      rawMaterials.set(
        node.itemId,
        (rawMaterials.get(node.itemId) || 0) + node.productionRate,
      );
    } else if (node.productionRate > 0) {
      uniqueProductionSteps++;
    }
  });

  const {
    totalPower,
    perFacility,
    rawPerFacility,
    totalBuildings,
    totalTiles,
    multiFormulaActualBuildings,
    multiFormulaBaselineBuildings,
  } = aggregates;

  const rawMaterialPickupPoints = new Map<ItemId, number>();
  let totalPickupPoints = 0;
  let pumpPickupPoints = 0;
  rawMaterials.forEach((rate, itemId) => {
    const item = getItemById(items, itemId);
    const count = getPickupPointCount(rate, getRawSourceRate(itemId, item));
    rawMaterialPickupPoints.set(itemId, count);
    totalPickupPoints += count;
    const source = rawMaterialSources.get(itemId)?.sourceFacility;
    if (source && pumpFacilityIds.has(source)) pumpPickupPoints += count;
  });

  const disposal = Array.from(disposalByItem.entries())
    .map(([itemId, ratePerMinute]) => {
      const item = getItemById(items, itemId);
      return item ? { item, ratePerMinute } : null;
    })
    .filter((e): e is { item: Item; ratePerMinute: number } => e !== null)
    .sort((a, b) => b.ratePerMinute - a.ratePerMinute);

  return {
    totalPowerConsumption: totalPower,
    rawMaterialRequirements: rawMaterials,
    uniqueProductionSteps,
    facilityRequirements: perFacility,
    totalBuildings,
    totalTiles,
    groupedSavings: Math.max(
      0,
      multiFormulaBaselineBuildings - multiFormulaActualBuildings,
    ),
    rawFacilityRequirements: rawPerFacility,
    totalPickupPoints,
    depotPickupPoints: totalPickupPoints - pumpPickupPoints,
    pumpPickupPoints,
    rawMaterialPickupPoints,
    disposal,
    metastorageImports: plan.metastorageImports,
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
        totalBuildings: 0,
        totalTiles: 0,
        groupedSavings: 0,
        rawFacilityRequirements: new Map(),
        totalPickupPoints: 0,
        depotPickupPoints: 0,
        pumpPickupPoints: 0,
        rawMaterialPickupPoints: new Map(),
        disposal: [],
        metastorageImports: [],
        facilityOverCapMap: new Map(),
      };
    }

    return collectStats(plan, aggregates, facilityOverCapMap, manualRawMaterials, items);
  }, [plan, aggregates, facilityOverCapMap, manualRawMaterials, items]);
}
