import { describe, test, expect } from "vitest";
import { solveLP, type LPInput } from "@/lib/lp-solver";
import type { Recipe, Facility } from "@/types";
import { ItemId, RecipeId, FacilityId } from "@/types/constants";

const FAC: Facility = {
  id: "fac_test" as FacilityId,
  powerConsumption: 10,
  tier: 1,
  category: 0,
  buffersIn: { belt: [], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
};
const FAC_HEAVY: Facility = {
  id: "fac_heavy" as FacilityId,
  powerConsumption: 50,
  tier: 1,
  category: 0,
  buffersIn: { belt: [], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
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

describe("solveLP — raw-cap enforcement", () => {
  // r1: 1 raw → 1 out (30/min/fac). Demand = 30 out/min → 1 fac → 30 raw/min.
  const buildSingleRecipeInput = (
    rawCaps?: ReadonlyMap<ItemId, number>,
  ): LPInput => {
    const r1 = makeRecipe(
      "r1",
      [{ itemId: "raw" as ItemId, amount: 1 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
    );
    return {
      recipes: [r1],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 30 }],
        ["raw" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["raw" as ItemId]),
      costlessRaws: new Set(),
      rawCaps,
      facilityMap: facMap,
    };
  };

  test("cap non-binding (cap > demand): no slack engages", async () => {
    // Demand = 30 raw/min; cap = 100. Slack should be zero.
    const result = await solveLP(
      buildSingleRecipeInput(new Map([["raw" as ItemId, 100]])),
    );
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.rawCapOveruse.size).toBe(0);
    expect(result.facilityCounts.get("r1" as RecipeId)).toBeCloseTo(1, 5);
  });

  test("cap binding (cap < demand): slack reports the overage", async () => {
    // Demand = 30 raw/min; cap = 10. The LP can't reduce consumption
    // (only one recipe), so slack absorbs 20/min.
    const result = await solveLP(
      buildSingleRecipeInput(new Map([["raw" as ItemId, 10]])),
    );
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.rawCapOveruse.get("raw" as ItemId)).toBeCloseTo(20, 3);
    // The plan still completes — target met, recipe runs.
    expect(result.facilityCounts.get("r1" as RecipeId)).toBeCloseTo(1, 5);
  });

  test("cap = 0: slack absorbs full consumption", async () => {
    const result = await solveLP(
      buildSingleRecipeInput(new Map([["raw" as ItemId, 0]])),
    );
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.rawCapOveruse.get("raw" as ItemId)).toBeCloseTo(30, 3);
  });

  test("no rawCaps: behaves as if no constraint was added", async () => {
    const result = await solveLP(buildSingleRecipeInput(undefined));
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.rawCapOveruse.size).toBe(0);
  });

  test("empty rawCaps: behaves as if no constraint was added", async () => {
    const result = await solveLP(buildSingleRecipeInput(new Map()));
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.rawCapOveruse.size).toBe(0);
  });

  test("recipe choice biased by cap: cap-friendly recipe wins when alternatives exist", async () => {
    // rA: 1 raw → 1 out (consumes 30 raw/min for 30 out/min)
    // rB: 3 raw → 1 out (consumes 90 raw/min for 30 out/min)
    // Without caps: LP picks rA (lower rawCost).
    // With cap=15: even rA can't fit, but LP still picks rA over rB
    // (rA's overage = 15; rB's overage = 75; LP minimizes slack).
    const rA = makeRecipe(
      "rA",
      [{ itemId: "raw" as ItemId, amount: 1 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
    );
    const rB = makeRecipe(
      "rB",
      [{ itemId: "raw" as ItemId, amount: 3 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
    );
    const input: LPInput = {
      recipes: [rA, rB],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 30 }],
        ["raw" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["raw" as ItemId]),
      costlessRaws: new Set(),
      rawCaps: new Map([["raw" as ItemId, 15]]),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    // LP picks rA (1 fac), not rB.
    expect(result.facilityCounts.get("rA" as RecipeId)).toBeCloseTo(1, 5);
    expect(result.facilityCounts.get("rB" as RecipeId) ?? 0).toBeCloseTo(0, 5);
    // Slack absorbs 30 − 15 = 15.
    expect(result.rawCapOveruse.get("raw" as ItemId)).toBeCloseTo(15, 3);
  });

  test("multi-cap independence: each cap reports its own overage", async () => {
    // r1: raw1 + raw2 → out (1 of each per 1 out)
    // Demand = 30 out → 30 raw1 + 30 raw2.
    // raw1 cap = 10 → overage 20; raw2 cap = 20 → overage 10.
    const r1 = makeRecipe(
      "r1",
      [
        { itemId: "raw1" as ItemId, amount: 1 },
        { itemId: "raw2" as ItemId, amount: 1 },
      ],
      [{ itemId: "out" as ItemId, amount: 1 }],
    );
    const input: LPInput = {
      recipes: [r1],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 30 }],
        ["raw1" as ItemId, { type: "min", rhs: 0 }],
        ["raw2" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["raw1" as ItemId, "raw2" as ItemId]),
      costlessRaws: new Set(),
      rawCaps: new Map([
        ["raw1" as ItemId, 10],
        ["raw2" as ItemId, 20],
      ]),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.rawCapOveruse.get("raw1" as ItemId)).toBeCloseTo(20, 3);
    expect(result.rawCapOveruse.get("raw2" as ItemId)).toBeCloseTo(10, 3);
  });

  test("invalid cap values (negative, NaN) are silently skipped", async () => {
    // Defensive: lp-solver itself skips invalid caps to avoid crashing
    // on bad input. The App layer + setter already filter, but the LP
    // shouldn't be the only line of defense.
    const result = await solveLP(
      buildSingleRecipeInput(
        new Map([
          ["raw" as ItemId, -5], // negative
          ["other_raw" as ItemId, NaN], // not-a-number
        ]),
      ),
    );
    if (!result.feasible) throw new Error("expected feasible");
    // No slack engaged because no caps were actually applied.
    expect(result.rawCapOveruse.size).toBe(0);
  });
});
