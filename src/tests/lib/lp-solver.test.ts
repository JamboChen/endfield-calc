import { describe, test, expect } from "vitest";
import { solveLP, type LPInput } from "@/lib/lp-solver";
import type { Recipe, Facility } from "@/types";
import { ItemId, RecipeId, FacilityId } from "@/types/constants";

const FAC: Facility = {
  id: "fac_test" as FacilityId,
  numId: 0,
  powerConsumption: 10,
  tier: 1,
  category: 0,
  buffersIn: { belt: [], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
  cap: null,
};
const FAC_HEAVY: Facility = {
  id: "fac_heavy" as FacilityId,
  numId: 0,
  powerConsumption: 50,
  tier: 1,
  category: 0,
  buffersIn: { belt: [], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
  cap: null,
};
const facMap = new Map<FacilityId, Facility>([
  [FAC.id, FAC],
  [FAC_HEAVY.id, FAC_HEAVY],
]);

const makeRecipe = (
  id: string,
  inputs: { itemId: ItemId; amount: number }[],
  outputs: { itemId: ItemId; amount: number }[],
  craftingTime = 2,
  facilityId: FacilityId = FAC.id,
): Recipe => ({
  id: id as RecipeId,
  inputs,
  outputs,
  craftingTime,
  facilityId,
});

describe("solveLP", () => {
  test("trivial single-recipe meets target", async () => {
    const recipe = makeRecipe(
      "r1",
      [{ itemId: "raw" as ItemId, amount: 1 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
    );
    const input: LPInput = {
      recipes: [recipe],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 30 }],
        ["raw" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["raw" as ItemId]),
      costlessRaws: new Set(),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    // To produce 30/min at rate=30/fac/min → 1 facility.
    expect(result.facilityCounts.get("r1" as RecipeId)).toBeCloseTo(1, 5);
  });

  test("two-recipe chain — LP picks both at correct rates", async () => {
    // r1: raw → mid (rate 30/fac/min)
    // r2: mid → out (rate 30/fac/min)
    // Demand: out ≥ 60/min → r2 = 2 fac, r1 = 2 fac (consumes 60 mid/min, produced by r1).
    const r1 = makeRecipe(
      "r1",
      [{ itemId: "raw" as ItemId, amount: 1 }],
      [{ itemId: "mid" as ItemId, amount: 1 }],
    );
    const r2 = makeRecipe(
      "r2",
      [{ itemId: "mid" as ItemId, amount: 1 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
    );
    const input: LPInput = {
      recipes: [r1, r2],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 60 }],
        ["mid" as ItemId, { type: "equal", rhs: 0 }],
        ["raw" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["raw" as ItemId]),
      costlessRaws: new Set(),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.facilityCounts.get("r1" as RecipeId)).toBeCloseTo(2, 5);
    expect(result.facilityCounts.get("r2" as RecipeId)).toBeCloseTo(2, 5);
  });

  test("cycle with disposal slack — LP minimizes power", async () => {
    // Pool: 1 raw_a + 1 raw_b → 1 product + 1 waste (2s/cycle)
    // Purifier: 4 waste → 1 product (2s/cycle)
    // Demand: product ≥ 5/min, both same power.
    // Constraints: 30P + 30Q ≥ 5 (product) and 30P - 120Q ≥ 0 (waste).
    // Raw-min: minimize 30P (raw_a + raw_b each = 30P). With Q = P/4
    // (lower bound on waste), 5P/4 ≥ 1/6 → P = 4/30, Q = 1/30.
    const pool = makeRecipe(
      "pool",
      [
        { itemId: "raw_a" as ItemId, amount: 1 },
        { itemId: "raw_b" as ItemId, amount: 1 },
      ],
      [
        { itemId: "product" as ItemId, amount: 1 },
        { itemId: "waste" as ItemId, amount: 1 },
      ],
    );
    const purifier = makeRecipe(
      "purifier",
      [{ itemId: "waste" as ItemId, amount: 4 }],
      [{ itemId: "product" as ItemId, amount: 1 }],
    );
    const input: LPInput = {
      recipes: [pool, purifier],
      itemConstraints: new Map([
        ["product" as ItemId, { type: "min", rhs: 5 }],
        ["waste" as ItemId, { type: "min", rhs: 0 }], // disposable
        ["raw_a" as ItemId, { type: "min", rhs: 0 }],
        ["raw_b" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["raw_a" as ItemId, "raw_b" as ItemId]),
      costlessRaws: new Set(),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.facilityCounts.get("pool" as RecipeId)).toBeCloseTo(4 / 30, 5);
    expect(result.facilityCounts.get("purifier" as RecipeId)).toBeCloseTo(1 / 30, 5);
  });

  test("byproduct deficit — LP scales producer accepting primary surplus", async () => {
    // furnace: 1 ore → 1 nugget + 1 sewage
    // pool: 1 sewage → 1 product
    // Demand: nugget ≥ 1/min AND product ≥ 4/min
    // Pool needs 4 sewage; furnace produces 1 sewage per nugget at 30/fac/min.
    // So furnace = 4/30 (produces 4 sewage = 4/min, also produces 4 nugget;
    // surplus 3 nugget/min has no consumer but is allowed).
    const furnace = makeRecipe(
      "furnace",
      [{ itemId: "ore" as ItemId, amount: 1 }],
      [
        { itemId: "nugget" as ItemId, amount: 1 },
        { itemId: "sewage" as ItemId, amount: 1 },
      ],
    );
    const pool = makeRecipe(
      "pool",
      [{ itemId: "sewage" as ItemId, amount: 1 }],
      [{ itemId: "product" as ItemId, amount: 1 }],
    );
    const input: LPInput = {
      recipes: [furnace, pool],
      itemConstraints: new Map([
        ["nugget" as ItemId, { type: "min", rhs: 1 }], // ≥ 1 (surplus OK)
        ["sewage" as ItemId, { type: "min", rhs: 0 }], // disposable
        ["product" as ItemId, { type: "min", rhs: 4 }],
        ["ore" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["ore" as ItemId]),
      costlessRaws: new Set(),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.facilityCounts.get("furnace" as RecipeId)).toBeCloseTo(4 / 30, 5);
    expect(result.facilityCounts.get("pool" as RecipeId)).toBeCloseTo(4 / 30, 5);
  });

  test("multi-producer with different power costs — LP picks cheaper", async () => {
    // Two recipes producing the same item, different power.
    // Demand: out ≥ 30/min.
    // r_cheap (power 10): 1 raw → 1 out
    // r_expensive (power 50): 1 raw → 1 out
    // Both consume 1 raw. raw-min is tied. Power-min picks r_cheap.
    const rCheap = makeRecipe(
      "r_cheap",
      [{ itemId: "raw" as ItemId, amount: 1 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
      2,
      FAC.id,
    );
    const rExpensive = makeRecipe(
      "r_expensive",
      [{ itemId: "raw" as ItemId, amount: 1 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
      2,
      FAC_HEAVY.id,
    );
    const input: LPInput = {
      recipes: [rCheap, rExpensive],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 30 }],
        ["raw" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["raw" as ItemId]),
      costlessRaws: new Set(),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    // LP should pick r_cheap exclusively.
    expect(result.facilityCounts.get("r_cheap" as RecipeId)).toBeCloseTo(1, 5);
    expect(result.facilityCounts.get("r_expensive" as RecipeId)).toBeCloseTo(0, 5);
  });

  test("infeasible system returns failure", async () => {
    // Recipe needs 1 raw → 1 out, but demand on out is 30 with raw constraint
    // forcing raw consumption ≤ 0.
    const recipe = makeRecipe(
      "r1",
      [{ itemId: "raw" as ItemId, amount: 1 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
    );
    const input: LPInput = {
      recipes: [recipe],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "equal", rhs: 30 }],
        ["raw" as ItemId, { type: "equal", rhs: 0 }], // can't consume raw — infeasible
      ]),
      rawMaterials: new Set(),
      costlessRaws: new Set(),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    expect(result.feasible).toBe(false);
  });

  test("empty recipe set returns trivial feasible solution", async () => {
    const input: LPInput = {
      recipes: [],
      itemConstraints: new Map(),
      rawMaterials: new Set(),
      costlessRaws: new Set(),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    expect(result.feasible).toBe(true);
    if (result.feasible) {
      expect(result.facilityCounts.size).toBe(0);
      expect(result.totalPower).toBe(0);
    }
  });

  test("disposalDeficits is empty when SCC is internally balanced", async () => {
    // Same recipe shapes as the deficit test but no pinning — LP scales
    // furnace to satisfy sewage demand. Slack should be 0, so
    // disposalDeficits should not contain `sewage`.
    const furnace = makeRecipe(
      "furnace",
      [{ itemId: "ore" as ItemId, amount: 1 }],
      [
        { itemId: "nugget" as ItemId, amount: 1 },
        { itemId: "sewage" as ItemId, amount: 1 },
      ],
    );
    const pool = makeRecipe(
      "pool",
      [{ itemId: "sewage" as ItemId, amount: 1 }],
      [{ itemId: "product" as ItemId, amount: 1 }],
    );
    const input: LPInput = {
      recipes: [furnace, pool],
      itemConstraints: new Map([
        ["sewage" as ItemId, { type: "disposal-slack", rhs: 0 }],
        ["nugget" as ItemId, { type: "min", rhs: 1 }],
        ["product" as ItemId, { type: "min", rhs: 4 }],
        ["ore" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["ore" as ItemId]),
      costlessRaws: new Set(),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.disposalDeficits.has("sewage" as ItemId)).toBe(false);
  });

  test("lex multi-pass: prefers raw-min over power", async () => {
    // r_low_power (power 5) consumes 2 raw per cycle, produces 1 out.
    // r_high_power (power 50) consumes 1 raw per cycle, produces 1 out.
    // Demand: out ≥ 30/min.
    // raw-min picks r_high_power (consumes less raw per output).
    // Lexicographic raw → power keeps r_high_power even though r_low_power
    // has lower power.
    const rLowPower = makeRecipe(
      "r_low_power",
      [{ itemId: "raw" as ItemId, amount: 2 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
      2,
      FAC.id, // power 10
    );
    const rHighPower = makeRecipe(
      "r_high_power",
      [{ itemId: "raw" as ItemId, amount: 1 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
      2,
      FAC_HEAVY.id, // power 50
    );
    const input: LPInput = {
      recipes: [rLowPower, rHighPower],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 30 }],
        ["raw" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["raw" as ItemId]),
      costlessRaws: new Set(),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    // Lex: minimize raw first → r_high_power exclusively.
    expect(result.facilityCounts.get("r_high_power" as RecipeId)).toBeCloseTo(1, 5);
    expect(result.facilityCounts.get("r_low_power" as RecipeId)).toBeCloseTo(0, 5);
  });

  test("lex-cap excludes slack — power minimization works under forced slack", async () => {
    // Regression for the lex_raw_cap slack-inclusion bug: before the fix,
    // pass-2 was infeasible whenever slack > 0, falling back to pass-1
    // and skipping power minimization. Among raw-degenerate recipes the
    // solver then picked by declaration order. Setup: 2 power-asymmetric
    // recipes with identical raw cost, plus a disposal-slack constraint
    // forcing slack ≥ 1. Recipes ordered [expensive, cheap] to expose
    // the bug.
    const rExpensive = makeRecipe(
      "rExpensive",
      [{ itemId: "raw" as ItemId, amount: 1 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
      2,
      FAC_HEAVY.id, // power 50
    );
    const rCheap = makeRecipe(
      "rCheap",
      [{ itemId: "raw" as ItemId, amount: 1 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
      2,
      FAC.id, // power 10
    );

    const input: LPInput = {
      recipes: [rExpensive, rCheap],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 30 }],
        ["raw" as ItemId, { type: "min", rhs: 0 }],
        [
          "forced_disposal" as ItemId,
          { type: "disposal-slack", rhs: 1 },
        ],
      ]),
      rawMaterials: new Set(["raw" as ItemId]),
      costlessRaws: new Set(),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");

    // Power-minimal pick: rCheap (FAC, 10W). Without the fix, the fallback
    // would pick rExpensive (FAC_HEAVY, 50W) due to declaration order.
    expect(result.facilityCounts.get("rCheap" as RecipeId)).toBeCloseTo(1, 5);
    expect(result.facilityCounts.get("rExpensive" as RecipeId) ?? 0).toBeCloseTo(0, 5);
    expect(result.totalPower).toBeCloseTo(10, 1);
    // Slack should propagate as a disposal deficit equal to the rhs.
    expect(
      result.disposalDeficits.get("forced_disposal" as ItemId),
    ).toBeCloseTo(1, 5);
  });
});
