import { describe, test, expect } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import {
  aggregateBinTotals,
  buildBinActivitySums,
  computeGreedyAllocation,
  computeNodeByproducts,
} from "@/lib/plan-helpers";
import { items, recipes, facilities, rawMaterialSources } from "@/data";
import { getRawSourceRate } from "@/lib/utils";
import { ItemId as ItemIdEnum, FacilityId as FacilityIdEnum } from "@/types/constants";
import type { ProductionDependencyGraph } from "@/types";

/**
 * Source-facility (pickup-point) contribution that `aggregateBinTotals`
 * now folds into the totals. Tests that assert bin-only math must add
 * this back when comparing against per-bin reductions.
 *
 * `ceilMode=true` uses ceiled pickup count (physical pumps); `ceilMode=false`
 * uses fractional pickup count (theoretical view). Mirrors the bin-loop
 * semantic in `aggregateBinTotals`.
 */
function expectedPickupContribution(
  plan: ProductionDependencyGraph,
  ceilMode: boolean = true,
): {
  buildings: number;
  power: number;
} {
  let buildings = 0;
  let power = 0;
  const facilityById = new Map(facilities.map((f) => [f.id, f]));
  const itemById = new Map(items.map((i) => [i.id, i]));
  for (const node of plan.nodes.values()) {
    if (node.type !== "item") continue;
    if (!node.isRawMaterial || node.productionRate <= 0) continue;
    const cfg = rawMaterialSources.get(node.itemId);
    if (!cfg) continue;
    const fac = facilityById.get(cfg.sourceFacility);
    if (!fac) continue;
    const item = itemById.get(node.itemId);
    const rate = getRawSourceRate(node.itemId, item);
    if (rate <= 0) continue;
    const fractional = node.productionRate / rate;
    const effective = ceilMode ? Math.ceil(fractional) : fractional;
    buildings += effective;
    power += fac.powerConsumption * effective;
  }
  return { buildings, power };
}
import type {
  Item,
  Recipe,
  Facility,
  ProductionNode,
  Bin,
  BinId,
  ItemId,
  RecipeId,
  FacilityId,
} from "@/types";

describe("computeGreedyAllocation", () => {
  test("single producer, single consumer — direct assignment", async () => {
    const result = computeGreedyAllocation(
      [{ recipeId: "A", rate: 60 }],
      [{ consumerId: "C1", demand: 60 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "A", consumerId: "C1", rate: 60 },
    ]);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(0);
  });

  test("single producer, demand less than production — surplus remains", async () => {
    const result = computeGreedyAllocation(
      [{ recipeId: "A", rate: 60 }],
      [{ consumerId: "C1", demand: 30 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "A", consumerId: "C1", rate: 30 },
    ]);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(30);
  });

  test("multi-producer, single consumer — largest fills first", async () => {
    // Furnace (60) + Crucible (30) → SCC consumer (60)
    // Furnace alone satisfies demand. Crucible is surplus.
    const result = computeGreedyAllocation(
      [
        { recipeId: "furnace", rate: 60 },
        { recipeId: "crucible", rate: 30 },
      ],
      [{ consumerId: "scc", demand: 60 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "furnace", consumerId: "scc", rate: 60 },
    ]);
    expect(result.remainingByProducer.get("furnace")).toBeCloseTo(0);
    expect(result.remainingByProducer.get("crucible")).toBeCloseTo(30);
  });

  test("multi-producer, single consumer — demand exceeds largest producer", async () => {
    // Producer A (40) + Producer B (30) → Consumer (60)
    // A fills 40, B fills remaining 20. B has 10 surplus.
    const result = computeGreedyAllocation(
      [
        { recipeId: "A", rate: 40 },
        { recipeId: "B", rate: 30 },
      ],
      [{ consumerId: "C1", demand: 60 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "A", consumerId: "C1", rate: 40 },
      { producerRecipeId: "B", consumerId: "C1", rate: 20 },
    ]);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(0);
    expect(result.remainingByProducer.get("B")).toBeCloseTo(10);
  });

  test("multi-producer, multiple consumers — greedy minimizes edges", async () => {
    // Producers: A (30), B (30)
    // Consumers: C1 (30), C2 (20)
    // Greedy: A fills C1 entirely, B fills C2 with 10 surplus.
    const result = computeGreedyAllocation(
      [
        { recipeId: "A", rate: 30 },
        { recipeId: "B", rate: 30 },
      ],
      [
        { consumerId: "C1", demand: 30 },
        { consumerId: "C2", demand: 20 },
      ],
    );

    // A (or B, both equal rate) fills C1 entirely
    expect(result.consumerEdges).toHaveLength(2);

    // Each consumer gets exactly one edge (one producer each)
    const c1Edges = result.consumerEdges.filter(
      (e) => e.consumerId === "C1",
    );
    const c2Edges = result.consumerEdges.filter(
      (e) => e.consumerId === "C2",
    );
    expect(c1Edges).toHaveLength(1);
    expect(c1Edges[0].rate).toBeCloseTo(30);
    expect(c2Edges).toHaveLength(1);
    expect(c2Edges[0].rate).toBeCloseTo(20);

    // 10 surplus from the second producer
    const totalRemaining = Array.from(
      result.remainingByProducer.values(),
    ).reduce((sum, v) => sum + v, 0);
    expect(totalRemaining).toBeCloseTo(10);
  });

  test("demand exceeds total production — allocates what's available", async () => {
    const result = computeGreedyAllocation(
      [{ recipeId: "A", rate: 30 }],
      [{ consumerId: "C1", demand: 60 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "A", consumerId: "C1", rate: 30 },
    ]);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(0);
  });

  test("no consumers — all production remains for disposal", async () => {
    const result = computeGreedyAllocation(
      [
        { recipeId: "A", rate: 60 },
        { recipeId: "B", rate: 30 },
      ],
      [],
    );

    expect(result.consumerEdges).toHaveLength(0);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(60);
    expect(result.remainingByProducer.get("B")).toBeCloseTo(30);
  });

  test("producers are sorted by rate regardless of input order", async () => {
    // Input order: small first. Should still assign large producer first.
    const result = computeGreedyAllocation(
      [
        { recipeId: "small", rate: 10 },
        { recipeId: "large", rate: 50 },
      ],
      [{ consumerId: "C1", demand: 50 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "large", consumerId: "C1", rate: 50 },
    ]);
    expect(result.remainingByProducer.get("large")).toBeCloseTo(0);
    expect(result.remainingByProducer.get("small")).toBeCloseTo(10);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// computeNodeByproducts
//
// Pure-function unit tests for the byproduct list rendered on a production
// node's card. The function has two distinct paths (grouped bin vs.
// singleton/per-recipe) and the historical display bug came from blindly
// combining both — leading to internally-balanced items leaking onto the
// card. These tests pin each path's behaviour.
// ──────────────────────────────────────────────────────────────────────────

// ── Synthetic fixtures (no real-data drift exposure) ─────────────────────
const xirconItem: Item = {
  id: "item_xiranite_poly" as ItemId,
  tier: 3,
};
const sewageItem: Item = {
  id: "item_liquid_sewage" as ItemId,
  tier: 3,
  isLiquid: true,
};
const lowpolyItem: Item = {
  id: "item_liquid_xiranite_lowpoly" as ItemId,
  tier: 3,
  isLiquid: true,
};
const xiraniteItem: Item = {
  id: "item_liquid_xiranite" as ItemId,
  tier: 3,
  isLiquid: true,
};
const polyItem: Item = {
  id: "item_liquid_xiranite_poly_intermediate" as ItemId,
  tier: 3,
  isLiquid: true,
};
const ironItem: Item = {
  id: "item_iron_powder" as ItemId,
  tier: 1,
};
const TEST_ITEMS: Item[] = [
  xirconItem,
  sewageItem,
  lowpolyItem,
  xiraniteItem,
  polyItem,
  ironItem,
];

// X recipe: 2 Poly + Iron → 1 Xircon + 1 Sewage (cycle 2s = 30/min).
const xRecipe: Recipe = {
  id: "pool_xiranite_poly_1" as RecipeId,
  inputs: [
    { itemId: polyItem.id, amount: 2 },
    { itemId: ironItem.id, amount: 1 },
  ],
  outputs: [
    { itemId: xirconItem.id, amount: 1 },
    { itemId: sewageItem.id, amount: 1 },
  ],
  facilityId: "mix_pool_1" as FacilityId,
  craftingTime: 2,
};

const facility: Facility = {
  id: "mix_pool_2" as FacilityId,
  numId: 81,
  powerConsumption: 100,
  tier: 3,
  category: 27,
  buffersIn: { belt: [{ ports: 4 }], pipe: [{ ports: 1 }, { ports: 1 }] },
  buffersOut: { belt: [{ ports: 4 }], pipe: [{ ports: 1 }, { ports: 1 }] },
  cacheSlots: 8,
  domains: [],
  cap: null,
};

const baseNode = (): ProductionNode => ({
  item: xirconItem,
  targetRate: 60, // 2 buildings × 30/min Xircon
  recipe: xRecipe,
  facility,
  facilityCount: 2,
  isRawMaterial: false,
  isTarget: true,
  dependencies: [],
});

describe("computeNodeByproducts", () => {
  describe("per-recipe view (no bin)", () => {
    test("includes recipe's secondary outputs scaled from primary", async () => {
      const node = baseNode();
      const result = computeNodeByproducts(node, TEST_ITEMS);
      expect(result).toHaveLength(1);
      expect(result[0].item.id).toBe(sewageItem.id);
      // Sewage rate = (1/1) × 60 = 60 (matches headline rate ratio).
      expect(result[0].rate).toBe(60);
      expect(result[0].amount).toBe(1);
    });

    test("excludes the headline item from byproducts", async () => {
      const node = baseNode();
      const result = computeNodeByproducts(node, TEST_ITEMS);
      const headlineInResult = result.some((b) => b.item.id === xirconItem.id);
      expect(headlineInResult).toBe(false);
    });

    test("recipe with single output → empty byproducts", async () => {
      const singleOutputRecipe: Recipe = {
        id: "pool_liquid_liquid_xiranite_1" as RecipeId,
        inputs: [{ itemId: ironItem.id, amount: 1 }],
        outputs: [{ itemId: xiraniteItem.id, amount: 1 }],
        facilityId: "mix_pool_1" as FacilityId,
        craftingTime: 2,
      };
      const node: ProductionNode = {
        ...baseNode(),
        item: xiraniteItem,
        targetRate: 30,
        recipe: singleOutputRecipe,
      };
      expect(computeNodeByproducts(node, TEST_ITEMS)).toEqual([]);
    });

    test("rate falls back to per-facility when no primary output match", async () => {
      // Defensive path: recipe has multi outputs but neither matches
      // node.item.id (data inconsistency). Should not happen in practice
      // but the function tolerates it via per-facility rate fallback.
      const oddRecipe: Recipe = {
        ...xRecipe,
        outputs: [
          { itemId: sewageItem.id, amount: 1 },
          { itemId: lowpolyItem.id, amount: 2 },
        ],
      };
      const node: ProductionNode = {
        ...baseNode(),
        recipe: oddRecipe,
        facilityCount: 3,
      };
      const result = computeNodeByproducts(node, TEST_ITEMS);
      // Both outputs become byproducts since neither matches node.item.id;
      // each uses calcRate(amount, 2) × 3 as the rate.
      expect(result).toHaveLength(2);
      const sewage = result.find((b) => b.item.id === sewageItem.id);
      const lowpoly = result.find((b) => b.item.id === lowpolyItem.id);
      expect(sewage?.rate).toBe(90); // 30/min × 3 buildings
      expect(lowpoly?.rate).toBe(180); // 60/min × 3 buildings
    });
  });

  describe("grouped bin (bin-fused, the fixed bug case)", () => {
    // Bin shape {LX, XE, X} where Sewage and Xiranite are internal, and
    // Lowpoly is the only external byproduct (beyond the headline Xircon).
    const groupedBin: Bin = {
      id: "bin-grouped" as BinId,
      facilityId: facility.id,
      recipeIds: [
        "pool_liquid_liquid_xiranite_1" as RecipeId,
        "pool_liquid_xiranite_poly_1" as RecipeId,
        "pool_xiranite_poly_1" as RecipeId,
      ],
      buildingCount: 2,
      externalInputs: [
        { itemId: ironItem.id, rate: 60, isLiquid: false },
        { itemId: polyItem.id, rate: 60, isLiquid: true },
      ],
      externalOutputs: [
        { itemId: xirconItem.id, rate: 60, isLiquid: false },
        { itemId: lowpolyItem.id, rate: 60, isLiquid: true },
        // NOTE: Sewage intentionally NOT present — it's internal.
      ],
      internalItems: [sewageItem.id, xiraniteItem.id],
      prefillCandidates: [],
      innerSlotsUsed: 8,
      isGrouped: true,
      variantId: "fac:grouped#v0",
    };

    test("uses ONLY bin's binExtraOutputs, never headline recipe's outputs", async () => {
      // Headline recipe is X (recipe.outputs = [Xircon, Sewage]); naive
      // implementation would re-add Sewage. The fixed implementation
      // routes around recipe.outputs entirely for grouped bins.
      const node: ProductionNode = {
        ...baseNode(),
        binId: groupedBin.id,
        binSisterRecipeIds: [
          "pool_liquid_liquid_xiranite_1" as RecipeId,
          "pool_liquid_xiranite_poly_1" as RecipeId,
        ],
        binExtraOutputs: groupedBin.externalOutputs
          .filter((o) => o.itemId !== xirconItem.id)
          .map((o) => ({
            itemId: o.itemId,
            rate: o.rate,
            isLiquid: o.isLiquid,
          })),
        bin: groupedBin,
      };
      const result = computeNodeByproducts(node, TEST_ITEMS);
      // Exactly one byproduct: Lowpoly. NOT Sewage.
      expect(result).toHaveLength(1);
      expect(result[0].item.id).toBe(lowpolyItem.id);
      expect(result[0].rate).toBe(60);
      const sewageLeaked = result.some((b) => b.item.id === sewageItem.id);
      expect(sewageLeaked).toBe(false);
    });

    test("empty binExtraOutputs → empty byproducts even with multi-output recipe", async () => {
      // Grouped bin where headline is also the only external output.
      const node: ProductionNode = {
        ...baseNode(),
        binId: groupedBin.id,
        binExtraOutputs: [],
        bin: { ...groupedBin, externalOutputs: [{ itemId: xirconItem.id, rate: 60, isLiquid: false }] },
      };
      expect(computeNodeByproducts(node, TEST_ITEMS)).toEqual([]);
    });
  });

  describe("singleton bin (bin-fused but only one recipe)", () => {
    test("falls through to recipe.outputs path (node.bin is undefined)", async () => {
      // The bin-fused mapper sets `bin: bin.isGrouped ? bin : undefined`,
      // so singleton bins have node.bin === undefined and binExtraOutputs
      // === undefined. The function falls through to the recipe path.
      const node: ProductionNode = {
        ...baseNode(),
        binId: "bin-singleton" as BinId,
        bin: undefined,
        binExtraOutputs: undefined,
      };
      const result = computeNodeByproducts(node, TEST_ITEMS);
      expect(result).toHaveLength(1);
      expect(result[0].item.id).toBe(sewageItem.id);
      expect(result[0].rate).toBe(60);
    });

    test("isGrouped=false bin acts like singleton", async () => {
      // Defensive: if a caller mis-supplies bin with isGrouped:false (shouldn't
      // happen in practice), the function should still fall through to the
      // recipe path rather than treating it as grouped.
      const node: ProductionNode = {
        ...baseNode(),
        bin: {
          id: "bin-not-grouped" as BinId,
          facilityId: facility.id,
          recipeIds: [xRecipe.id],
          buildingCount: 2,
          externalInputs: [],
          externalOutputs: [],
          internalItems: [],
          prefillCandidates: [],
          innerSlotsUsed: 4,
          isGrouped: false,
          variantId: "fac:not-grouped#v0",
        },
        binExtraOutputs: undefined,
      };
      const result = computeNodeByproducts(node, TEST_ITEMS);
      expect(result).toHaveLength(1);
      expect(result[0].item.id).toBe(sewageItem.id);
    });
  });

  describe("dedupe semantics", () => {
    test("primary item never appears in byproducts even if in binExtraOutputs", async () => {
      // Defensive: bin-fused-mapper filters headline out of binExtraOutputs,
      // but the function should also dedupe defensively.
      const groupedBin: Bin = {
        id: "bin-dedupe" as BinId,
        facilityId: facility.id,
        recipeIds: [xRecipe.id, "sister_1" as RecipeId],
        buildingCount: 1,
        externalInputs: [],
        externalOutputs: [
          { itemId: xirconItem.id, rate: 30, isLiquid: false },
          { itemId: lowpolyItem.id, rate: 30, isLiquid: true },
        ],
        internalItems: [],
        prefillCandidates: [],
        innerSlotsUsed: 4,
        isGrouped: true,
        variantId: "fac:dedupe#v0",
      };
      const node: ProductionNode = {
        ...baseNode(),
        targetRate: 30,
        facilityCount: 1,
        bin: groupedBin,
        binExtraOutputs: [
          // Note: includes the headline item itself — function should drop it.
          { itemId: xirconItem.id, rate: 30, isLiquid: false },
          { itemId: lowpolyItem.id, rate: 30, isLiquid: true },
        ],
      };
      const result = computeNodeByproducts(node, TEST_ITEMS);
      expect(result.map((b) => b.item.id)).toEqual([lowpolyItem.id]);
    });

    test("returns empty list when items lookup is missing for all entries", async () => {
      const node: ProductionNode = {
        ...baseNode(),
        bin: {
          id: "bin-missing-items" as BinId,
          facilityId: facility.id,
          recipeIds: [xRecipe.id, "sister_1" as RecipeId],
          buildingCount: 1,
          externalInputs: [],
          externalOutputs: [],
          internalItems: [],
          prefillCandidates: [],
          innerSlotsUsed: 1,
          isGrouped: true,
          variantId: "fac:missing-items#v0",
        },
        binExtraOutputs: [
          { itemId: "item_does_not_exist" as ItemId, rate: 30, isLiquid: false },
        ],
      };
      expect(computeNodeByproducts(node, TEST_ITEMS)).toEqual([]);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// aggregateBinTotals
//
// Single source of truth for "how many physical buildings", "how much
// power", and "per-facility breakdown". Both useProductionStats and
// useProductionTable consume this. Tests use real game data so they
// catch interactions between Phase 2 LP, Phase 3 MIP, and the bin
// aggregation in one place.
// ──────────────────────────────────────────────────────────────────────────

describe("aggregateBinTotals (real data)", () => {
  test("ceilMode=true: Xircon target=6 Expanded count = 1 (regression: was 3 with per-recipe ceiling)", async () => {
    // Per-recipe Phase 2 demands at target=6 are tiny fractions
    // (LX=0.32, XE=0.32, X=0.2). MIP packs them all into a single
    // {LX, XE, X} Expanded bin with buildingCount=1. Per-recipe-ceiled
    // counting (the old useProductionStats logic) would report
    // 1+1+1 = 3 Expanded; bin-iteration reports 1.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 6 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items, { ceilMode: true });
    expect(totals.perFacility.get(FacilityIdEnum.MIX_POOL_2)).toBe(1);
  });

  test("ceilMode=true: Xircon target=57 Expanded count matches plan.bins aggregate", async () => {
    // At target=57 MIP picks 2×{LX,XE,X} + 2×{LX,XE} = 4 Expanded.
    // The helper must agree with a direct count over bins.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items, { ceilMode: true });
    const expandedDirectCount = plan.bins
      .filter((b) => b.facilityId === FacilityIdEnum.MIX_POOL_2)
      .reduce((s, b) => s + Math.max(1, Math.ceil(b.buildingCount)), 0);
    expect(totals.perFacility.get(FacilityIdEnum.MIX_POOL_2))
      .toBe(expandedDirectCount);
    expect(totals.perFacility.get(FacilityIdEnum.MIX_POOL_2))
      .toBe(4);
  });

  test("ceilMode=false: totalPower equals Σ facility.power × mean(activities) per bin + pickup-source power", async () => {
    // In ceilMode=OFF, each bin contributes the mean of its recipe
    // activities (sum_alloc / recipe_count) — not the raw buildingCount.
    // For singletons the mean equals buildingCount; for grouped bins it
    // is strictly ≤ buildingCount. Pickup-point source facilities mirror
    // the bin-loop semantic: fractional under ceilMode=OFF.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items);
    const sumByBin = buildBinActivitySums(plan);

    let binPower = 0;
    const facilityById = new Map(facilities.map((f) => [f.id, f]));
    for (const bin of plan.bins) {
      const fac = facilityById.get(bin.facilityId);
      if (!fac) continue;
      const recipeCount = Math.max(1, bin.recipeIds.length);
      const sumActivities = sumByBin.get(bin.id) ?? bin.buildingCount;
      binPower += fac.powerConsumption * (sumActivities / recipeCount);
    }
    const pickup = expectedPickupContribution(plan, false);
    expect(totals.totalPower).toBeCloseTo(binPower + pickup.power, 6);
  });

  test("ceilMode=true: totalBuildings equals Σ ceil(bin.buildingCount) over all bins + pickup-point sources", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items, { ceilMode: true });
    const binTotal = plan.bins.reduce(
      (s, b) => s + Math.max(1, Math.ceil(b.buildingCount)),
      0,
    );
    const pickup = expectedPickupContribution(plan);
    expect(totals.totalBuildings).toBe(binTotal + pickup.buildings);
  });

  test("ceilMode=false (default): totalBuildings equals Σ mean(activities) per bin + pickup-point sources", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items);
    const sumByBin = buildBinActivitySums(plan);

    const binTotal = plan.bins.reduce((s, b) => {
      const recipeCount = Math.max(1, b.recipeIds.length);
      const sumActivities = sumByBin.get(b.id) ?? b.buildingCount;
      return s + sumActivities / recipeCount;
    }, 0);
    const pickup = expectedPickupContribution(plan, false);
    expect(totals.totalBuildings).toBeCloseTo(binTotal + pickup.buildings, 6);
  });

  test("ceilMode=false: grouped Xircon bin contributes mean strictly below buildingCount", async () => {
    // The user-facing semantic: in ceilMode=OFF, bf=1 surfaces the
    // partial-load info that the integer bin.buildingCount hides for
    // grouped bins. The variant LP picks active rates that honour
    // the variant's regime; for partial-load demand the
    // mean activity strictly undercuts bin.buildingCount (which is the
    // ceiled physical count). The specific numeric value depends on
    // which variant the LP picks; the invariant `mean ≤ buildingCount`
    // always holds by construction.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
    );
    const sumByBin = buildBinActivitySums(plan);
    const xirconBin = plan.bins.find((b) =>
      b.recipeIds.length === 3 &&
      b.facilityId === FacilityIdEnum.MIX_POOL_2,
    );
    expect(xirconBin).toBeDefined();
    const sumActivities = sumByBin.get(xirconBin!.id) ?? 0;
    const mean = sumActivities / xirconBin!.recipeIds.length;
    // Mean must be strictly below buildingCount (partial-load case) and
    // non-trivially positive (some active usage).
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan(xirconBin!.buildingCount);
  });

  test("ceilMode=OFF mean ≤ ceilMode=ON ceil for every bin (invariant)", async () => {
    // Mathematical invariant: each recipe's slot allocation ≤ bin.buildingCount
    // (allocator caps at bc), so sum ≤ bc × recipeCount, so mean ≤ bc.
    // Verify across the full Xircon-target test matrix.
    const TARGETS = [6, 30, 56, 57, 58, 60, 89, 90, 91];
    for (const target of TARGETS) {
      const plan = await calculateProductionPlan(
        [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: target }],
        items,
        recipes,
        facilities,
      );
      const sumByBin = buildBinActivitySums(plan);
      for (const bin of plan.bins) {
        const recipeCount = Math.max(1, bin.recipeIds.length);
        const sumActivities = sumByBin.get(bin.id) ?? bin.buildingCount;
        const mean = sumActivities / recipeCount;
        expect(mean).toBeLessThanOrEqual(bin.buildingCount + 1e-9);
      }
    }
  });

  test("multiFormulaBaseline >= multiFormulaActual (savings non-negative)", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items);
    expect(totals.multiFormulaBaselineBuildings)
      .toBeGreaterThanOrEqual(totals.multiFormulaActualBuildings);
  });

  test("multiFormulaActual sums only bins on multi-formula-eligible facilities", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items);
    const facilityById = new Map(facilities.map((f) => [f.id, f]));
    let expected = 0;
    for (const bin of plan.bins) {
      const fac = facilityById.get(bin.facilityId);
      if (fac?.cacheSlots != null) {
        expected += Math.max(1, Math.ceil(bin.buildingCount));
      }
    }
    expect(totals.multiFormulaActualBuildings).toBe(expected);
  });

  test("perFacility entries sum to totalBuildings (ceilMode=true)", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items, { ceilMode: true });
    const sum = Array.from(totals.perFacility.values()).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBe(totals.totalBuildings);
  });

  test("perFacility entries sum to totalBuildings (ceilMode=false)", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items);
    const sum = Array.from(totals.perFacility.values()).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBeCloseTo(totals.totalBuildings, 6);
  });

  test("empty plan returns zero aggregates", async () => {
    const emptyPlan = {
      nodes: new Map(),
      edges: [],
      targets: new Set<ItemId>(),
      detectedCycles: [],
      invalidCycles: [],
      bins: [],
      recipeBinAllocations: new Map(),
      warnings: [],
    };
    const totals = aggregateBinTotals(emptyPlan, facilities, items);
    expect(totals.totalBuildings).toBe(0);
    expect(totals.totalPower).toBe(0);
    expect(totals.perFacility.size).toBe(0);
    expect(totals.multiFormulaActualBuildings).toBe(0);
    expect(totals.multiFormulaBaselineBuildings).toBe(0);
  });

  test("bin on unknown facility id is ignored (defensive)", async () => {
    // Synthesize a plan with a bin pointing to a facility id that's
    // not in the facilities list. The helper should skip it rather
    // than crash.
    const plan = {
      nodes: new Map(),
      edges: [],
      targets: new Set<ItemId>(),
      detectedCycles: [],
      invalidCycles: [],
      bins: [
        {
          id: "bin-orphan" as BinId,
          facilityId: "not_a_real_facility" as FacilityId,
          recipeIds: [],
          buildingCount: 1,
          externalInputs: [],
          externalOutputs: [],
          internalItems: [],
          prefillCandidates: [],
          innerSlotsUsed: 0,
          isGrouped: false,
          variantId: "orphan:#v0",
        },
      ],
      recipeBinAllocations: new Map(),
      warnings: [],
    };
    const totals = aggregateBinTotals(plan, facilities, items);
    expect(totals.totalBuildings).toBe(0);
    expect(totals.totalPower).toBe(0);
  });

  test("ceilMode=true: Furnace singleton (fractional buildingCount) ceils up to 1", async () => {
    // Sewage feeder runs at fractional building count (e.g.
    // furnace_copper_nugget at 0.12 for target=6). With ceilMode=true,
    // Math.max(1, Math.ceil(...)) makes a tiny fractional contribute 1.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 6 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items, { ceilMode: true });
    const furnaceCount = totals.perFacility.get(
      FacilityIdEnum.FURNANCE_1,
    );
    expect(furnaceCount).toBeGreaterThanOrEqual(1);
  });

  test("ceilMode=false: Furnace facility count uses raw buildingCount sums", async () => {
    // With ceilMode=false (proportional view), perFacility[Furnace]
    // sums raw bin.buildingCount (one bin per Furnace recipe in the
    // chain — IronNugget, CopperNugget, etc.). Each individual bin's
    // contribution is fractional; the sum is typically non-integer.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 6 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items, { ceilMode: false });
    const furnaceCount = totals.perFacility.get(
      FacilityIdEnum.FURNANCE_1,
    );
    expect(furnaceCount).toBeDefined();

    // Independently sum raw bin.buildingCount over Furnace bins.
    const expected = plan.bins
      .filter((b) => b.facilityId === FacilityIdEnum.FURNANCE_1)
      .reduce((s, b) => s + b.buildingCount, 0);
    expect(furnaceCount!).toBeCloseTo(expected, 6);
  });

  test("ceilMode=true ≥ ceilMode=false for any per-facility entry", async () => {
    // Whole-building ceiling can only increase counts, never decrease.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 6 }],
      items,
      recipes,
      facilities,
    );
    const ceiled = aggregateBinTotals(plan, facilities, items, { ceilMode: true });
    const fractional = aggregateBinTotals(plan, facilities, items, {
      ceilMode: false,
    });
    for (const [facId, ceiledCount] of ceiled.perFacility.entries()) {
      const fractionalCount = fractional.perFacility.get(facId) ?? 0;
      expect(ceiledCount).toBeGreaterThanOrEqual(fractionalCount - 1e-9);
    }
  });

  test("ceilMode=true: power for fractional bin uses full ceiled-building power", async () => {
    // The user's complaint: at low rates, total power should reflect
    // physical building cost (full power per built building) not
    // proportional. With ceilMode=true, a 0.12-building Furnace pays
    // its full 5W (Furnace tier-1 power), not 0.6W proportional.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 6 }],
      items,
      recipes,
      facilities,
    );
    const ceiledTotals = aggregateBinTotals(plan, facilities, items, {
      ceilMode: true,
    });
    const fractionalTotals = aggregateBinTotals(plan, facilities, items, {
      ceilMode: false,
    });
    // Ceiled power must be ≥ fractional power (each fractional building
    // gets bumped up to a full building's power consumption).
    expect(ceiledTotals.totalPower).toBeGreaterThan(fractionalTotals.totalPower);
  });

  test("ceilMode=true: power equals Σ fac.power × ceil(bin.buildingCount) + pickup-source power", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 6 }],
      items,
      recipes,
      facilities,
    );
    const totals = aggregateBinTotals(plan, facilities, items, { ceilMode: true });
    const facilityById = new Map(facilities.map((f) => [f.id, f]));
    let binPower = 0;
    for (const bin of plan.bins) {
      const fac = facilityById.get(bin.facilityId);
      if (!fac) continue;
      binPower +=
        fac.powerConsumption * Math.max(1, Math.ceil(bin.buildingCount));
    }
    const pickup = expectedPickupContribution(plan);
    expect(totals.totalPower).toBeCloseTo(binPower + pickup.power, 6);
  });

  test("multiFormulaActual/Baseline are always-ceiled regardless of ceilMode", async () => {
    // These are physical counterfactuals for the groupedSavings metric;
    // they must stay integer regardless of ceilMode.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemIdEnum.ITEM_XIRANITE_POLY, rate: 6 }],
      items,
      recipes,
      facilities,
    );
    const ceiled = aggregateBinTotals(plan, facilities, items, { ceilMode: true });
    const fractional = aggregateBinTotals(plan, facilities, items, {
      ceilMode: false,
    });
    expect(ceiled.multiFormulaActualBuildings).toBe(
      fractional.multiFormulaActualBuildings,
    );
    expect(ceiled.multiFormulaBaselineBuildings).toBe(
      fractional.multiFormulaBaselineBuildings,
    );
    expect(Number.isInteger(ceiled.multiFormulaActualBuildings)).toBe(true);
    expect(Number.isInteger(ceiled.multiFormulaBaselineBuildings)).toBe(true);
  });
});
