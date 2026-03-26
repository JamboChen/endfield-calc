import { describe, test, expect } from "vitest";
import { CapacityPoolManager } from "@/components/flow/capacity-pool";
import type { ItemId, FacilityId, RecipeId } from "@/types";

// Minimal mock data for pool creation
const mockItem = {
  id: "item_test" as ItemId,
  tier: 1,
};

const mockProductionNode = (
  targetRate: number,
  facilityCount: number,
) => ({
  item: mockItem,
  targetRate,
  recipe: {
    id: "recipe_test" as RecipeId,
    inputs: [],
    outputs: [{ itemId: mockItem.id, amount: 1 }],
    facilityId: "facility_test" as FacilityId,
    craftingTime: 2,
  },
  facility: { id: "facility_test" as FacilityId, powerConsumption: 10, tier: 1 },
  facilityCount,
  isRawMaterial: false,
  isTarget: false,
  dependencies: [],
});

describe("CapacityPoolManager.allocateByproduct", () => {
  test("allocates from processed facilities without consuming pool capacity", () => {
    const pm = new CapacityPoolManager();
    pm.createPool(mockProductionNode(60, 2), "recipe_A");

    // Mark both facilities as processed (simulating main loop activation)
    pm.markProcessed("recipe_A-f0");
    pm.markProcessed("recipe_A-f1");

    // Allocate byproduct — demandRate is in primary output units
    const results = pm.allocateByproduct("recipe_A", 40, "item_byproduct");

    // Should allocate from processed facilities
    const totalAllocated = results.reduce(
      (sum, r) => sum + r.allocatedAmount,
      0,
    );
    expect(totalAllocated).toBeCloseTo(40);

    // Pool primary capacity should be UNTOUCHED (byproduct is free)
    const facilities = pm.getFacilityInstances("recipe_A");
    const totalRemaining = facilities.reduce(
      (sum, f) => sum + f.remainingCapacity,
      0,
    );
    expect(totalRemaining).toBeCloseTo(60); // Full capacity preserved
  });

  test("returns empty when no facilities are running", () => {
    const pm = new CapacityPoolManager();
    pm.createPool(mockProductionNode(60, 2), "recipe_A");

    // Don't process any facilities — none are running
    const results = pm.allocateByproduct("recipe_A", 30, "item_byproduct");

    expect(results).toHaveLength(0);
  });

  test("allocates from capacity-consumed facilities even if not processed", () => {
    const pm = new CapacityPoolManager();
    pm.createPool(mockProductionNode(60, 2), "recipe_A");

    // Consume primary capacity via allocate() (not markProcessed)
    pm.allocate("recipe_A", 30);

    // Byproduct should be available from the consumed facility
    const results = pm.allocateByproduct("recipe_A", 30, "item_byproduct");

    const totalAllocated = results.reduce(
      (sum, r) => sum + r.allocatedAmount,
      0,
    );
    expect(totalAllocated).toBeCloseTo(30);
  });

  test("respects conversion ratio for non-1:1 byproducts", () => {
    const pm = new CapacityPoolManager();
    // Pool with 30/min primary capacity (1 facility)
    pm.createPool(mockProductionNode(30, 1), "recipe_A");
    pm.markProcessed("recipe_A-f0");

    // Byproduct has 2:1 ratio (2 byproduct per 1 primary)
    // Facility produces 30/min primary → 60/min byproduct
    // Demand is in primary output units. The caller converts byproduct
    // demand (60/min) to primary units (60/2 = 30/min) before calling.
    const results = pm.allocateByproduct("recipe_A", 30, "item_byproduct");

    const totalAllocated = results.reduce(
      (sum, r) => sum + r.allocatedAmount,
      0,
    );
    // Should allocate 30 (primary units). Caller converts back: 30 * 2 = 60 byproduct
    expect(totalAllocated).toBeCloseTo(30);
  });

  test("tracks per-item allocation to prevent over-allocation", () => {
    const pm = new CapacityPoolManager();
    pm.createPool(mockProductionNode(30, 1), "recipe_A");
    pm.markProcessed("recipe_A-f0");

    // First consumer takes 20/min (primary units)
    const first = pm.allocateByproduct("recipe_A", 20, "item_byproduct");
    expect(first.reduce((s, r) => s + r.allocatedAmount, 0)).toBeCloseTo(20);

    // Second consumer tries to take 20/min — only 10 remains
    const second = pm.allocateByproduct("recipe_A", 20, "item_byproduct");
    expect(second.reduce((s, r) => s + r.allocatedAmount, 0)).toBeCloseTo(10);
  });

  test("tracks different byproduct items independently", () => {
    const pm = new CapacityPoolManager();
    pm.createPool(mockProductionNode(30, 1), "recipe_A");
    pm.markProcessed("recipe_A-f0");

    // Allocate all of byproduct_X
    const xResults = pm.allocateByproduct("recipe_A", 30, "item_x");
    expect(xResults.reduce((s, r) => s + r.allocatedAmount, 0)).toBeCloseTo(30);

    // Byproduct_Y should still have full availability (tracked independently)
    const yResults = pm.allocateByproduct("recipe_A", 30, "item_y");
    expect(yResults.reduce((s, r) => s + r.allocatedAmount, 0)).toBeCloseTo(30);
  });

  test("primary allocate() after byproduct still works — independent capacity", () => {
    const pm = new CapacityPoolManager();
    pm.createPool(mockProductionNode(60, 2), "recipe_A");
    pm.markProcessed("recipe_A-f0");
    pm.markProcessed("recipe_A-f1");

    // Byproduct allocation from both facilities
    pm.allocateByproduct("recipe_A", 60, "item_byproduct");

    // Primary allocation should still have full capacity
    const primaryResults = pm.allocate("recipe_A", 60);
    const totalPrimary = primaryResults.reduce(
      (sum, r) => sum + r.allocatedAmount,
      0,
    );
    expect(totalPrimary).toBeCloseTo(60);
  });

  test("partial facility handles byproduct correctly", () => {
    const pm = new CapacityPoolManager();
    // 2.5 facilities → 3 instances, last at half capacity
    pm.createPool(mockProductionNode(75, 2.5), "recipe_A");
    pm.markProcessed("recipe_A-f0");
    pm.markProcessed("recipe_A-f1");
    pm.markProcessed("recipe_A-f2");

    // All three facilities running. f0=30, f1=30, f2=15
    const results = pm.allocateByproduct("recipe_A", 75, "item_byproduct");
    const totalAllocated = results.reduce(
      (sum, r) => sum + r.allocatedAmount,
      0,
    );
    expect(totalAllocated).toBeCloseTo(75);
  });

  test("caps allocation at primary capacity — not inflated by conversion ratio", () => {
    const pm = new CapacityPoolManager();
    // Pool with 30/min primary capacity (1 facility)
    pm.createPool(mockProductionNode(30, 1), "recipe_A");
    pm.markProcessed("recipe_A-f0");

    // Demand exceeds primary capacity (40 > 30 in primary units).
    // Before fix: totalByproduct = 30 * 2.5 = 75, so Math.min(75, 40) = 40
    //   → over-allocation (40 > actual capacity of 30).
    // After fix: byproductCapacity = 30, so Math.min(30, 40) = 30 → correct.
    const results = pm.allocateByproduct("recipe_A", 40, "item_byproduct");

    const totalAllocated = results.reduce(
      (sum, r) => sum + r.allocatedAmount,
      0,
    );
    expect(totalAllocated).toBeCloseTo(30);
  });

  test("multi-consumer tracking consistent across calls with high demand", () => {
    const pm = new CapacityPoolManager();
    // Pool with 30/min primary capacity (1 facility)
    pm.createPool(mockProductionNode(30, 1), "recipe_A");
    pm.markProcessed("recipe_A-f0");

    // First consumer takes 20/min (in primary units)
    const first = pm.allocateByproduct("recipe_A", 20, "item_byproduct");
    expect(first.reduce((s, r) => s + r.allocatedAmount, 0)).toBeCloseTo(20);

    // Second consumer requests 20/min — only 10 remains.
    // Before fix with ratio 2.5: totalByproduct = 75, alreadyAllocated = 20,
    //   available = 55, Math.min(55, 20) = 20 → over-allocation (total 40 > 30).
    // After fix: byproductCapacity = 30, alreadyAllocated = 20,
    //   available = 10, Math.min(10, 20) = 10 → correct.
    const second = pm.allocateByproduct("recipe_A", 20, "item_byproduct");
    expect(second.reduce((s, r) => s + r.allocatedAmount, 0)).toBeCloseTo(10);

    // Total across both consumers must not exceed facility capacity
    const total =
      first.reduce((s, r) => s + r.allocatedAmount, 0) +
      second.reduce((s, r) => s + r.allocatedAmount, 0);
    expect(total).toBeCloseTo(30);
  });
});
