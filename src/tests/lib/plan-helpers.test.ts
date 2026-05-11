import { describe, test, expect } from "vitest";
import { computeGreedyAllocation, computeNodeByproducts } from "@/lib/plan-helpers";
import type {
  Item,
  Recipe,
  Facility,
  ProductionNode,
  CrucibleBin,
  ItemId,
  RecipeId,
  FacilityId,
} from "@/types";

describe("computeGreedyAllocation", () => {
  test("single producer, single consumer — direct assignment", () => {
    const result = computeGreedyAllocation(
      [{ recipeId: "A", rate: 60 }],
      [{ consumerId: "C1", demand: 60 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "A", consumerId: "C1", rate: 60 },
    ]);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(0);
  });

  test("single producer, demand less than production — surplus remains", () => {
    const result = computeGreedyAllocation(
      [{ recipeId: "A", rate: 60 }],
      [{ consumerId: "C1", demand: 30 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "A", consumerId: "C1", rate: 30 },
    ]);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(30);
  });

  test("multi-producer, single consumer — largest fills first", () => {
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

  test("multi-producer, single consumer — demand exceeds largest producer", () => {
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

  test("multi-producer, multiple consumers — greedy minimizes edges", () => {
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

  test("demand exceeds total production — allocates what's available", () => {
    const result = computeGreedyAllocation(
      [{ recipeId: "A", rate: 30 }],
      [{ consumerId: "C1", demand: 60 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "A", consumerId: "C1", rate: 30 },
    ]);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(0);
  });

  test("no consumers — all production remains for disposal", () => {
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

  test("producers are sorted by rate regardless of input order", () => {
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
  facilityId: "item_port_mix_pool_1" as FacilityId,
  craftingTime: 2,
};

const facility: Facility = {
  id: "item_port_mix_pool_2" as FacilityId,
  powerConsumption: 100,
  tier: 3,
  capabilities: {
    innerSlots: 8,
    liquidInPorts: 2,
    liquidOutPorts: 2,
    beltOutPorts: 1,
  },
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
    test("includes recipe's secondary outputs scaled from primary", () => {
      const node = baseNode();
      const result = computeNodeByproducts(node, TEST_ITEMS);
      expect(result).toHaveLength(1);
      expect(result[0].item.id).toBe(sewageItem.id);
      // Sewage rate = (1/1) × 60 = 60 (matches headline rate ratio).
      expect(result[0].rate).toBe(60);
      expect(result[0].amount).toBe(1);
    });

    test("excludes the headline item from byproducts", () => {
      const node = baseNode();
      const result = computeNodeByproducts(node, TEST_ITEMS);
      const headlineInResult = result.some((b) => b.item.id === xirconItem.id);
      expect(headlineInResult).toBe(false);
    });

    test("recipe with single output → empty byproducts", () => {
      const singleOutputRecipe: Recipe = {
        id: "pool_liquid_liquid_xiranite_1" as RecipeId,
        inputs: [{ itemId: ironItem.id, amount: 1 }],
        outputs: [{ itemId: xiraniteItem.id, amount: 1 }],
        facilityId: "item_port_mix_pool_1" as FacilityId,
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

    test("rate falls back to per-facility when no primary output match", () => {
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
    const groupedBin: CrucibleBin = {
      id: "bin-grouped" as string,
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
      innerSlotsUsed: 8,
      isGrouped: true,
    };

    test("uses ONLY bin's binExtraOutputs, never headline recipe's outputs", () => {
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

    test("empty binExtraOutputs → empty byproducts even with multi-output recipe", () => {
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
    test("falls through to recipe.outputs path (node.bin is undefined)", () => {
      // In bin-fused-mapper.ts:218, `bin: bin.isGrouped ? bin : undefined`,
      // so singleton bins have node.bin === undefined and binExtraOutputs
      // === undefined. The function falls through to the recipe path.
      const node: ProductionNode = {
        ...baseNode(),
        binId: "bin-singleton",
        bin: undefined,
        binExtraOutputs: undefined,
      };
      const result = computeNodeByproducts(node, TEST_ITEMS);
      expect(result).toHaveLength(1);
      expect(result[0].item.id).toBe(sewageItem.id);
      expect(result[0].rate).toBe(60);
    });

    test("isGrouped=false bin acts like singleton", () => {
      // Defensive: if a caller mis-supplies bin with isGrouped:false (shouldn't
      // happen in practice), the function should still fall through to the
      // recipe path rather than treating it as grouped.
      const node: ProductionNode = {
        ...baseNode(),
        bin: {
          id: "bin-not-grouped",
          facilityId: facility.id,
          recipeIds: [xRecipe.id],
          buildingCount: 2,
          externalInputs: [],
          externalOutputs: [],
          internalItems: [],
          innerSlotsUsed: 4,
          isGrouped: false,
        },
        binExtraOutputs: undefined,
      };
      const result = computeNodeByproducts(node, TEST_ITEMS);
      expect(result).toHaveLength(1);
      expect(result[0].item.id).toBe(sewageItem.id);
    });
  });

  describe("dedupe semantics", () => {
    test("primary item never appears in byproducts even if in binExtraOutputs", () => {
      // Defensive: bin-fused-mapper filters headline out of binExtraOutputs,
      // but the function should also dedupe defensively.
      const groupedBin: CrucibleBin = {
        id: "bin-dedupe",
        facilityId: facility.id,
        recipeIds: [xRecipe.id, "sister_1" as RecipeId],
        buildingCount: 1,
        externalInputs: [],
        externalOutputs: [
          { itemId: xirconItem.id, rate: 30, isLiquid: false },
          { itemId: lowpolyItem.id, rate: 30, isLiquid: true },
        ],
        internalItems: [],
        innerSlotsUsed: 4,
        isGrouped: true,
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

    test("returns empty list when items lookup is missing for all entries", () => {
      const node: ProductionNode = {
        ...baseNode(),
        bin: {
          id: "bin-missing-items",
          facilityId: facility.id,
          recipeIds: [xRecipe.id, "sister_1" as RecipeId],
          buildingCount: 1,
          externalInputs: [],
          externalOutputs: [],
          internalItems: [],
          innerSlotsUsed: 1,
          isGrouped: true,
        },
        binExtraOutputs: [
          { itemId: "item_does_not_exist" as ItemId, rate: 30, isLiquid: false },
        ],
      };
      expect(computeNodeByproducts(node, TEST_ITEMS)).toEqual([]);
    });
  });
});
