import type {
  CapacityPoolEntry,
  FacilityInstance,
  AllocationResult,
  ProductionNode,
} from "@/types";

/**
 * Manages capacity pools for production facilities in separated visualization mode.
 *
 * Creates individual facility instances from ProductionNodes and handles allocation
 * of their production capacity to downstream consumers using a greedy allocation strategy.
 */
export class CapacityPoolManager {
  private pools: Map<string, CapacityPoolEntry>;
  private processedFacilities: Set<string>;
  /** Tracks cumulative byproduct allocated per facility to prevent over-allocation */
  private byproductAllocated: Map<string, number>;

  constructor() {
    this.pools = new Map();
    this.processedFacilities = new Set();
    this.byproductAllocated = new Map();
  }

  /**
   * Checks if a capacity pool exists for the given node key.
   * Used for defensive checks before allocation.
   */
  hasPool(nodeKey: string): boolean {
    return this.pools.has(nodeKey);
  }

  /**
   * Creates a capacity pool for a production node by splitting it into individual facilities.
   * Each facility gets its own capacity. The last facility may operate at partial capacity
   * if the original facilityCount was fractional.
   */
  createPool(node: ProductionNode, nodeKey: string): void {
    if (node.isRawMaterial) return;

    const facilityCount = Math.ceil(node.facilityCount);
    const capacityPerFacility = node.targetRate / node.facilityCount;

    const facilities: FacilityInstance[] = Array.from(
      { length: facilityCount },
      (_, i) => {
        const remainingCapacity = node.targetRate - i * capacityPerFacility;
        const actualOutputRate = Math.max(
          0,
          Math.min(capacityPerFacility, remainingCapacity),
        );

        return {
          facilityId: `${nodeKey}-f${i}`,
          nodeKey,
          facilityIndex: i,
          maxOutputRate: capacityPerFacility,
          actualOutputRate,
          remainingCapacity: actualOutputRate,
        };
      },
    );

    this.pools.set(nodeKey, {
      productionNode: node,
      totalCapacity: node.targetRate,
      facilities,
    });
  }

  /**
   * Allocates production capacity from a producer to satisfy consumer demand.
   * Uses greedy allocation: fills facilities in order until demand is met.
   * May return multiple allocations if demand spans multiple facilities.
   */
  allocate(nodeKey: string, demandRate: number): AllocationResult[] {
    const pool = this.pools.get(nodeKey);
    if (!pool) {
      console.warn(`[CapacityPoolManager] Pool not found for key: ${nodeKey}`);
      return [];
    }

    const results: AllocationResult[] = [];
    let remainingDemand = demandRate;

    for (const facility of pool.facilities) {
      if (remainingDemand <= 0) break;
      if (facility.remainingCapacity <= 0) continue;

      const allocated = Math.min(facility.remainingCapacity, remainingDemand);
      facility.remainingCapacity -= allocated;
      remainingDemand -= allocated;

      results.push({
        sourceNodeId: facility.facilityId,
        allocatedAmount: allocated,
        fromFacilityIndex: facility.facilityIndex,
      });
    }

    if (remainingDemand > 0.001) {
      console.warn(
        `[CapacityPoolManager] Insufficient capacity for ${nodeKey}: ${remainingDemand.toFixed(2)}/min unsatisfied`,
      );
    }

    return results;
  }

  /**
   * Allocates byproduct output from running facilities.
   *
   * When a facility runs for its primary output, byproducts are produced "for
   * free" — one recipe execution produces all outputs simultaneously. This
   * method allocates from that free byproduct without consuming pool capacity
   * (which is denominated in primary output units).
   *
   * A facility is considered "running" if it has been processed (activated by
   * the main loop or first-visit in allocateFromPool) or if its primary
   * capacity has been consumed by a prior allocate() call.
   *
   * All tracking is in primary output units — one recipe execution produces
   * both primary and byproduct outputs, so byproduct capacity is 1:1 with
   * primary output rate. The caller is responsible for converting between
   * byproduct units and primary units before calling and after receiving
   * results. Allocation is tracked per facility to prevent over-allocation
   * when multiple consumers demand the same byproduct.
   *
   * If demand exceeds the free byproduct from running facilities, the caller
   * should follow up with a regular allocate() call for the remainder to
   * activate new facility instances.
   *
   * @param forceRunning When true, treat ALL facilities as running regardless
   *   of their processed/capacity state. Used for backward cycle edges where
   *   the SCC solver has already determined these facilities will run — their
   *   byproduct is guaranteed to be available even if the facility hasn't been
   *   visited yet in the current mapper pass.
   */
  allocateByproduct(
    nodeKey: string,
    demandRate: number,
    demandedItemId: string,
    forceRunning = false,
  ): AllocationResult[] {
    const pool = this.pools.get(nodeKey);
    if (!pool) return [];

    const results: AllocationResult[] = [];
    let remainingDemand = demandRate;

    for (const facility of pool.facilities) {
      if (remainingDemand <= 0.001) break;

      // A facility is "running" if it's been processed (main loop or
      // first-visit) or if its capacity has been consumed by allocate().
      // When forceRunning is set (backward cycle edges), skip this check
      // entirely — the SCC solver guarantees these facilities will run.
      if (!forceRunning) {
        const isRunning =
          this.processedFacilities.has(facility.facilityId) ||
          facility.remainingCapacity < facility.actualOutputRate - 0.001;

        if (!isRunning) continue;
      }

      // Byproduct capacity in primary output units. One recipe execution
      // produces both primary and byproduct outputs, so byproduct capacity
      // equals the primary output rate. The caller converts demand to primary
      // units before calling and converts results back afterward.
      const byproductCapacity = facility.actualOutputRate;

      // Subtract byproduct already allocated from this facility for this item.
      // Keyed by item ID (not recipe) so different byproducts from the same
      // recipe are tracked independently.
      const trackingKey = `${facility.facilityId}:${demandedItemId}`;
      const alreadyAllocated = this.byproductAllocated.get(trackingKey) || 0;
      const available = byproductCapacity - alreadyAllocated;

      if (available <= 0.001) continue;

      const allocated = Math.min(available, remainingDemand);
      this.byproductAllocated.set(trackingKey, alreadyAllocated + allocated);
      remainingDemand -= allocated;

      // Don't decrement remainingCapacity — byproduct is free.
      // The facility is already running for its primary output;
      // the byproduct is an inherent side effect of recipe execution.
      results.push({
        sourceNodeId: facility.facilityId,
        allocatedAmount: allocated,
        fromFacilityIndex: facility.facilityIndex,
      });
    }

    return results;
  }

  /**
   * Gets all facility instances for a given production node.
   */
  getFacilityInstances(nodeKey: string): FacilityInstance[] {
    return this.pools.get(nodeKey)?.facilities ?? [];
  }

  /**
   * Marks a facility as processed (dependencies have been recursively allocated).
   */
  markProcessed(facilityId: string): void {
    this.processedFacilities.add(facilityId);
  }

  /**
   * Checks if a facility instance has been processed.
   * Returns true if the facility's node and upstream dependencies have been created.
   */
  isProcessed(facilityId: string): boolean {
    return this.processedFacilities.has(facilityId);
  }
}
