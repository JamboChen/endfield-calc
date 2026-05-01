import { describe, test, expect } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { calcRate } from "@/lib/utils";
import { items } from "@/data/items";
import { recipes } from "@/data/recipes";
import { facilities } from "@/data/facilities";
import type {
  ProductionDependencyGraph,
  ProductionGraphNode,
  Recipe,
} from "@/types";
import { ItemId, RecipeId } from "@/types/constants";
import {
  mockItems,
  mockFacilities,
  simpleRecipes,
  multiRecipeItems,
  overrideCycleRecipes,
  cycleRecipes,
  complexRecipes,
  byproductRecipes,
  byproductSCCRecipes,
  xirconRecipes,
} from "./fixtures/test-data";

const getNode = (
  graph: ProductionDependencyGraph,
  id: string,
): ProductionGraphNode => {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`Node not found: ${id}`);
  return node;
};

const getItemNode = (graph: ProductionDependencyGraph, itemId: ItemId) => {
  const node = getNode(graph, itemId);
  if (node.type !== "item") throw new Error(`Node ${itemId} is not an item`);
  return node;
};

const getProducer = (
  graph: ProductionDependencyGraph,
  itemId: ItemId,
): { recipeId: RecipeId; node: ProductionGraphNode } | null => {
  const producerEdge = graph.edges.find((e) => e.to === itemId);
  if (!producerEdge) return null;
  return {
    recipeId: producerEdge.from as RecipeId,
    node: getNode(graph, producerEdge.from),
  };
};

const getRecipeInputs = (
  graph: ProductionDependencyGraph,
  recipeId: RecipeId,
): ItemId[] => {
  return graph.edges
    .filter((e) => e.to === recipeId)
    .map((e) => e.from as ItemId);
};

describe("Simple Production Plan", () => {
  test("calculates plan for single raw material", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_ORE, rate: 30 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
    );

    const node = getItemNode(plan, ItemId.ITEM_IRON_ORE);
    expect(node.itemId).toBe(ItemId.ITEM_IRON_ORE);
    expect(node.isRawMaterial).toBe(true);
    expect(plan.nodes.has(ItemId.ITEM_IRON_ORE)).toBe(true);
    expect(getProducer(plan, ItemId.ITEM_IRON_ORE)).toBeNull();
  });

  test("calculates plan for simple linear chain", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 30 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
    );

    const powderNode = getItemNode(plan, ItemId.ITEM_IRON_POWDER);
    expect(powderNode.isTarget).toBe(true);

    const powderProducer = getProducer(plan, ItemId.ITEM_IRON_POWDER);
    expect(powderProducer?.recipeId).toBe(RecipeId.GRINDER_IRON_POWDER_1);
    expect(powderProducer?.node.type).toBe("recipe");
    if (powderProducer?.node.type === "recipe") {
      expect(powderProducer.node.facilityCount).toBeCloseTo(1, 5);
    }

    const inputs = getRecipeInputs(plan, RecipeId.GRINDER_IRON_POWDER_1);
    expect(inputs).toContain(ItemId.ITEM_IRON_NUGGET);
    const nuggetNode = getItemNode(plan, ItemId.ITEM_IRON_NUGGET);
    expect(nuggetNode.productionRate).toBeCloseTo(30, 5);

    const nuggetProducer = getProducer(plan, ItemId.ITEM_IRON_NUGGET);
    expect(nuggetProducer?.recipeId).toBe(RecipeId.FURNANCE_IRON_NUGGET_1);
    if (nuggetProducer?.node.type === "recipe") {
      expect(nuggetProducer.node.facilityCount).toBeCloseTo(1, 5);
    }

    const nuggetInputs = getRecipeInputs(plan, RecipeId.FURNANCE_IRON_NUGGET_1);
    expect(nuggetInputs).toContain(ItemId.ITEM_IRON_ORE);
    const oreNode = getItemNode(plan, ItemId.ITEM_IRON_ORE);
    expect(oreNode.isRawMaterial).toBe(true);
    expect(getProducer(plan, ItemId.ITEM_IRON_ORE)).toBeNull();
  });

  test("calculates facility count correctly", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 60 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
    );

    const producer = getProducer(plan, ItemId.ITEM_IRON_POWDER);
    if (producer?.node.type === "recipe") {
      expect(producer.node.facilityCount).toBeCloseTo(2, 5);
    }

    const inputProducer = getProducer(plan, ItemId.ITEM_IRON_NUGGET);
    if (inputProducer?.node.type === "recipe") {
      expect(inputProducer.node.facilityCount).toBeCloseTo(2, 5);
    }
  });

  test("handles fractional facility counts", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 15 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
    );

    const producer = getProducer(plan, ItemId.ITEM_IRON_POWDER);
    if (producer?.node.type === "recipe") {
      expect(producer.node.facilityCount).toBeCloseTo(0.5, 5);
    }
  });
});

describe("Multiple Recipe Selection", () => {
  test("uses default selector to pick first recipe", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 30 }],
      mockItems,
      multiRecipeItems,
      mockFacilities,
      undefined,
    );

    const producer = getProducer(plan, ItemId.ITEM_IRON_NUGGET);
    expect(producer?.recipeId).toBe(RecipeId.FURNANCE_IRON_NUGGET_1);

    const inputs = getRecipeInputs(plan, RecipeId.FURNANCE_IRON_NUGGET_1);
    expect(inputs).toContain(ItemId.ITEM_IRON_ORE);
  });

  test("respects recipe overrides", () => {
    const overrides = new Map([
      [ItemId.ITEM_IRON_NUGGET, RecipeId.FURNANCE_IRON_NUGGET_2],
    ]);

    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 30 }],
      mockItems,
      multiRecipeItems,
      mockFacilities,
      overrides,
    );

    const producer = getProducer(plan, ItemId.ITEM_IRON_NUGGET);
    expect(producer?.recipeId).toBe(RecipeId.FURNANCE_IRON_NUGGET_2);

    const inputs = getRecipeInputs(plan, RecipeId.FURNANCE_IRON_NUGGET_2);
    expect(inputs).toContain(ItemId.ITEM_IRON_POWDER);
  });
});

describe("Override Cycle Resolution (Issue #51)", () => {
  // When the user overrides Iron Nugget to use FURNANCE_IRON_NUGGET_2
  // (Iron Powder → Iron Nugget), and Iron Powder's only recipe is
  // GRINDER_IRON_POWDER_1 (Iron Nugget → Iron Powder), this creates
  // a 1:1 balanced cycle with zero net output.
  //
  // The fix extends the SCC with the default recipe (FURNANCE_IRON_NUGGET_1)
  // as a feeder, producing the chain:
  // Iron Ore → FURNANCE_1 → Iron Nugget → GRINDER → Iron Powder → FURNANCE_2 → Iron Nugget

  test("resolves override cycle by adding feeder recipe", () => {
    const overrides = new Map([
      [ItemId.ITEM_IRON_NUGGET, RecipeId.FURNANCE_IRON_NUGGET_2],
    ]);

    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 30 }],
      mockItems,
      overrideCycleRecipes,
      mockFacilities,
      overrides,
    );

    // The plan should be valid — no invalid cycles
    expect(plan.invalidCycles).toHaveLength(0);

    // All three recipes should be in the plan with non-zero facility counts
    const furnace1 = plan.nodes.get(RecipeId.FURNANCE_IRON_NUGGET_1);
    const furnace2 = plan.nodes.get(RecipeId.FURNANCE_IRON_NUGGET_2);
    const grinder = plan.nodes.get(RecipeId.GRINDER_IRON_POWDER_1);

    expect(furnace1).toBeDefined();
    expect(furnace2).toBeDefined();
    expect(grinder).toBeDefined();

    if (furnace1?.type === "recipe") {
      expect(furnace1.facilityCount).toBeGreaterThan(0);
    }
    if (furnace2?.type === "recipe") {
      expect(furnace2.facilityCount).toBeGreaterThan(0);
    }
    if (grinder?.type === "recipe") {
      expect(grinder.facilityCount).toBeGreaterThan(0);
    }

    // Iron Ore should be consumed as a raw material
    const ironOre = getItemNode(plan, ItemId.ITEM_IRON_ORE);
    expect(ironOre.isRawMaterial).toBe(true);

    // Iron Nugget should be the target
    const ironNugget = getItemNode(plan, ItemId.ITEM_IRON_NUGGET);
    expect(ironNugget.isTarget).toBe(true);
    expect(ironNugget.productionRate).toBeGreaterThan(0);
  });

  test("feeder chain produces correct facility counts", () => {
    const overrides = new Map([
      [ItemId.ITEM_IRON_NUGGET, RecipeId.FURNANCE_IRON_NUGGET_2],
    ]);

    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 30 }],
      mockItems,
      overrideCycleRecipes,
      mockFacilities,
      overrides,
    );

    // All three recipes should run at 1 facility each (rate = 30/min per facility)
    const furnace1 = plan.nodes.get(RecipeId.FURNANCE_IRON_NUGGET_1);
    const furnace2 = plan.nodes.get(RecipeId.FURNANCE_IRON_NUGGET_2);
    const grinder = plan.nodes.get(RecipeId.GRINDER_IRON_POWDER_1);

    if (
      furnace1?.type === "recipe" &&
      furnace2?.type === "recipe" &&
      grinder?.type === "recipe"
    ) {
      expect(furnace1.facilityCount).toBeCloseTo(1, 2);
      expect(furnace2.facilityCount).toBeCloseTo(1, 2);
      expect(grinder.facilityCount).toBeCloseTo(1, 2);
    }
  });

  test("Iron Powder target with stale Iron Nugget override", () => {
    // User previously overrode Iron Nugget → FURNANCE_2, then changed
    // target to Iron Powder. The stale override creates the same cycle.
    const overrides = new Map([
      [ItemId.ITEM_IRON_NUGGET, RecipeId.FURNANCE_IRON_NUGGET_2],
    ]);

    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 30 }],
      mockItems,
      overrideCycleRecipes,
      mockFacilities,
      overrides,
    );

    // Iron Powder should be in the plan (not silently dropped)
    expect(plan.nodes.has(ItemId.ITEM_IRON_POWDER)).toBe(true);
    const ironPowder = getItemNode(plan, ItemId.ITEM_IRON_POWDER);
    expect(ironPowder.productionRate).toBeGreaterThan(0);
  });

  test("bottle cycle with overrides is resolved by feeder extension", () => {
    // The bottle filling/dismantling cycle with overrides. The test fixture's
    // SHAPER produces FBOTTLE directly, so the feeder extension successfully
    // resolves the cycle by adding SHAPER (for FBOTTLE) and POOL (for Liquid
    // Grass). The cycle is linearized and should not appear in detectedCycles.
    const overrides = new Map([
      [
        ItemId.ITEM_FBOTTLE_GLASS_GRASS_1,
        RecipeId.FILLING_BOTTLED_GLASS_GRASS_1,
      ],
      [ItemId.ITEM_LIQUID_PLANT_GRASS_1, RecipeId.DISMANTLER_GLASS_GRASS_1_1],
    ]);

    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_FBOTTLE_GLASS_GRASS_1, rate: 30 }],
      mockItems,
      cycleRecipes,
      mockFacilities,
      overrides,
    );

    // Cycle is resolved — no detected or invalid cycles
    expect(plan.invalidCycles).toHaveLength(0);
    expect(plan.nodes.has(ItemId.ITEM_FBOTTLE_GLASS_GRASS_1)).toBe(true);

    // FBOTTLE should be produced
    const fbottle = getItemNode(plan, ItemId.ITEM_FBOTTLE_GLASS_GRASS_1);
    expect(fbottle.productionRate).toBeGreaterThan(0);
  });

  test("failed extension produces invalidCycles with override info", () => {
    // Use a minimal recipe set with ONLY the cycle recipes (no SHAPER, no
    // POOL). Without external feeder recipes, the extension cannot resolve
    // the cycle and the SCC is marked invalid.
    const minimalCycleRecipes = cycleRecipes.filter(
      (r) =>
        r.id === RecipeId.FILLING_BOTTLED_GLASS_GRASS_1 ||
        r.id === RecipeId.DISMANTLER_GLASS_GRASS_1_1,
    );

    const overrides = new Map([
      [
        ItemId.ITEM_FBOTTLE_GLASS_GRASS_1,
        RecipeId.FILLING_BOTTLED_GLASS_GRASS_1,
      ],
      [ItemId.ITEM_LIQUID_PLANT_GRASS_1, RecipeId.DISMANTLER_GLASS_GRASS_1_1],
    ]);

    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_FBOTTLE_GLASS_GRASS_1, rate: 30 }],
      mockItems,
      minimalCycleRecipes,
      mockFacilities,
      overrides,
    );

    // Extension should fail — no feeder recipes available
    expect(plan.invalidCycles.length).toBeGreaterThan(0);

    const cycle = plan.invalidCycles[0];
    // The overridden items should be identified
    expect(cycle.overriddenItemIds.length).toBeGreaterThan(0);
    // The cycle should involve the bottle items
    expect(cycle.involvedItemIds).toContain(
      ItemId.ITEM_FBOTTLE_GLASS_GRASS_1,
    );
  });
});

describe("Multiple Targets", () => {
  test("calculates plan for multiple independent targets", () => {
    const plan = calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_IRON_POWDER, rate: 30 },
        { itemId: ItemId.ITEM_GLASS_CMPT, rate: 15 },
      ],
      mockItems,
      [...simpleRecipes, ...complexRecipes],
      mockFacilities,
    );

    const ironNode = getItemNode(plan, ItemId.ITEM_IRON_POWDER);
    const glassNode = getItemNode(plan, ItemId.ITEM_GLASS_CMPT);

    expect(ironNode.isTarget).toBe(true);
    expect(glassNode.isTarget).toBe(true);

    expect(getProducer(plan, ItemId.ITEM_IRON_POWDER)).not.toBeNull();
    expect(getProducer(plan, ItemId.ITEM_GLASS_CMPT)).not.toBeNull();
  });
});

describe("Complex Dependencies", () => {
  test("calculates multi-tier production plan", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 6 }],
      mockItems,
      complexRecipes,
      mockFacilities,
    );

    const batteryProducer = getProducer(plan, ItemId.ITEM_PROC_BATTERY_1);
    expect(batteryProducer).not.toBeNull();
    if (batteryProducer?.node.type === "recipe") {
      expect(batteryProducer.node.facilityCount).toBeCloseTo(1, 5);
    }

    const inputs = getRecipeInputs(plan, batteryProducer!.recipeId);
    expect(inputs).toContain(ItemId.ITEM_GLASS_CMPT);
    expect(inputs).toContain(ItemId.ITEM_IRON_CMPT);

    const glassNode = getItemNode(plan, ItemId.ITEM_GLASS_CMPT);
    expect(glassNode.productionRate).toBeCloseTo(30, 5);

    const ironNode = getItemNode(plan, ItemId.ITEM_IRON_CMPT);
    expect(ironNode.productionRate).toBeCloseTo(60, 5);
  });
});

describe("Cycle Detection", () => {
  test("bottle cycle with overrides is resolved by feeder extension", () => {
    // With the test fixture's SHAPER producing FBOTTLE directly, the feeder
    // extension resolves the cycle. The plan should be valid with FBOTTLE
    // produced via the linearized chain.
    const overrides = new Map([
      [
        ItemId.ITEM_FBOTTLE_GLASS_GRASS_1,
        RecipeId.FILLING_BOTTLED_GLASS_GRASS_1,
      ],
      [ItemId.ITEM_LIQUID_PLANT_GRASS_1, RecipeId.DISMANTLER_GLASS_GRASS_1_1],
    ]);

    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_FBOTTLE_GLASS_GRASS_1, rate: 30 }],
      mockItems,
      cycleRecipes,
      mockFacilities,
      overrides,
    );

    // Cycle resolved — no invalid cycles
    expect(plan.invalidCycles).toHaveLength(0);
    expect(plan.nodes.has(ItemId.ITEM_FBOTTLE_GLASS_GRASS_1)).toBe(true);

    // FBOTTLE should be produced at the target rate
    const fbottle = getItemNode(plan, ItemId.ITEM_FBOTTLE_GLASS_GRASS_1);
    expect(fbottle.productionRate).toBeGreaterThan(0);
  });

  test("cycle net outputs calculation", () => {
    const overrides = new Map([
      [
        ItemId.ITEM_FBOTTLE_GLASS_GRASS_1,
        RecipeId.FILLING_BOTTLED_GLASS_GRASS_1,
      ],
      [ItemId.ITEM_LIQUID_PLANT_GRASS_1, RecipeId.DISMANTLER_GLASS_GRASS_1_1],
    ]);

    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_FBOTTLE_GLASS_GRASS_1, rate: 30 }],
      mockItems,
      cycleRecipes,
      mockFacilities,
      overrides,
    );

    if (plan.detectedCycles.length > 0) {
      plan.nodes.forEach((node) => {
        if (node.type === "recipe") {
          expect(node.facilityCount).toBeGreaterThanOrEqual(0);
        }
      });
    }
  });
});

describe("Manual Raw Materials", () => {
  test("treats manually specified items as raw materials", () => {
    const manualRaw = new Set([ItemId.ITEM_IRON_NUGGET]);
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 30 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
      undefined,
      manualRaw,
    );

    const nuggetNode = getItemNode(plan, ItemId.ITEM_IRON_NUGGET);
    expect(nuggetNode.isRawMaterial).toBe(true);

    expect(getProducer(plan, ItemId.ITEM_IRON_NUGGET)).toBeNull();
  });

  test("manual raw materials override recipe availability", () => {
    const manualRaw = new Set([ItemId.ITEM_QUARTZ_GLASS]);
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_GLASS_CMPT, rate: 30 }],
      mockItems,
      complexRecipes,
      mockFacilities,
      undefined,
      manualRaw,
    );

    const glassNode = getItemNode(plan, ItemId.ITEM_QUARTZ_GLASS);
    expect(glassNode.isRawMaterial).toBe(true);
    expect(getProducer(plan, ItemId.ITEM_QUARTZ_GLASS)).toBeNull();
  });
});

describe("Edge Cases", () => {
  test("throws error for empty targets", () => {
    expect(() =>
      calculateProductionPlan([], mockItems, simpleRecipes, mockFacilities),
    ).toThrow("No targets specified");
  });

  test("handles item with no available recipes as raw material", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_QUARTZ_SAND, rate: 30 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
    );
    const sandNode = getItemNode(plan, ItemId.ITEM_QUARTZ_SAND);
    expect(sandNode.isRawMaterial).toBe(true);
    expect(getProducer(plan, ItemId.ITEM_QUARTZ_SAND)).toBeNull();
  });

  test("handles zero target rate", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 0 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
    );

    if (plan.nodes.has(ItemId.ITEM_IRON_POWDER)) {
      const producer = getProducer(plan, ItemId.ITEM_IRON_POWDER);
      if (producer?.node.type === "recipe") {
        expect(producer.node.facilityCount).toBe(0);
      }
    }
  });

  test("handles very small production rates", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 0.1 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
    );
    const producer = getProducer(plan, ItemId.ITEM_IRON_POWDER);
    if (producer?.node.type === "recipe") {
      expect(producer.node.facilityCount).toBeCloseTo(0.00333, 4);
    }
  });

  test("handles very large production rates", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 10000 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
    );
    const producer = getProducer(plan, ItemId.ITEM_IRON_POWDER);
    if (producer?.node.type === "recipe") {
      expect(producer.node.facilityCount).toBeCloseTo(333.333, 2);
    }
  });
});

describe("Recipe Output Amounts", () => {
  test("handles recipes with multiple output amounts", () => {
    const recipe: Recipe = {
      id: RecipeId.GRINDER_PLANT_MOSS_POWDER_1_1,
      inputs: [{ itemId: ItemId.ITEM_PLANT_MOSS_1, amount: 1 }],
      outputs: [{ itemId: ItemId.ITEM_PLANT_MOSS_POWDER_1, amount: 2 }],
      facilityId: mockFacilities[1].id,
      craftingTime: 2,
    };
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PLANT_MOSS_POWDER_1, rate: 60 }],
      mockItems,
      [recipe],
      mockFacilities,
    );

    const producer = getProducer(plan, ItemId.ITEM_PLANT_MOSS_POWDER_1);

    if (producer?.node.type === "recipe") {
      expect(producer.node.facilityCount).toBeCloseTo(1, 5);
    }

    const mossNode = getItemNode(plan, ItemId.ITEM_PLANT_MOSS_1);
    expect(mossNode.productionRate).toBeCloseTo(30, 5);
  });
});

describe("Byproduct Recipes", () => {
  test("handles recipes with byproduct outputs without crashing", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      mockItems,
      byproductRecipes,
      mockFacilities,
    );

    expect(plan.nodes.has(ItemId.ITEM_COPPER_CMPT)).toBe(true);
    expect(plan.nodes.has(ItemId.ITEM_COPPER_NUGGET)).toBe(true);
    expect(plan.nodes.has(ItemId.ITEM_LIQUID_SEWAGE)).toBe(true);

    const producer = getProducer(plan, ItemId.ITEM_COPPER_NUGGET);
    expect(producer?.recipeId).toBe(RecipeId.FURNANCE_COPPER_NUGGET_1);
  });

  test("byproduct items are not treated as raw materials", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      mockItems,
      byproductRecipes,
      mockFacilities,
    );

    const sewageNode = getItemNode(plan, ItemId.ITEM_LIQUID_SEWAGE);
    expect(sewageNode.isRawMaterial).toBe(false);
  });

  test("byproduct target reuses existing recipe instead of selecting a new one", () => {
    const plan = calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 },
        { itemId: ItemId.ITEM_LIQUID_SEWAGE, rate: 30 },
      ],
      mockItems,
      byproductRecipes,
      mockFacilities,
    );

    // Both items should use the same furnace recipe
    const nuggetProducer = getProducer(plan, ItemId.ITEM_COPPER_NUGGET);
    const sewageProducer = getProducer(plan, ItemId.ITEM_LIQUID_SEWAGE);
    expect(nuggetProducer?.recipeId).toBe(RecipeId.FURNANCE_COPPER_NUGGET_1);
    expect(sewageProducer?.recipeId).toBe(RecipeId.FURNANCE_COPPER_NUGGET_1);

    // Liquid Sewage should be a target
    const sewageNode = getItemNode(plan, ItemId.ITEM_LIQUID_SEWAGE);
    expect(sewageNode.isTarget).toBe(true);

    // Production rates should be correct for both outputs
    expect(sewageNode.productionRate).toBeCloseTo(30, 5);
    const nuggetNode = getItemNode(plan, ItemId.ITEM_COPPER_NUGGET);
    expect(nuggetNode.productionRate).toBeCloseTo(30, 5);
  });

  test("byproduct production rate scales with primary output demand", () => {
    const plan = calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 },
        { itemId: ItemId.ITEM_LIQUID_SEWAGE, rate: 60 },
      ],
      mockItems,
      byproductRecipes,
      mockFacilities,
    );

    // Sewage demands 60/min but furnace produces 30/min per facility
    // So furnace must scale to 2 facilities to meet both demands
    const sewageNode = getItemNode(plan, ItemId.ITEM_LIQUID_SEWAGE);
    expect(sewageNode.productionRate).toBeCloseTo(60, 5);

    // Copper nugget also gets 60/min (overproduction to meet sewage demand)
    const nuggetNode = getItemNode(plan, ItemId.ITEM_COPPER_NUGGET);
    expect(nuggetNode.productionRate).toBeCloseTo(60, 5);

    // Component recipe still only needs 1 facility for 30/min
    const cmptProducer = getProducer(plan, ItemId.ITEM_COPPER_CMPT);
    if (cmptProducer?.node.type === "recipe") {
      expect(cmptProducer.node.facilityCount).toBeCloseTo(1, 5);
    }
  });
});

describe("Byproduct with SCC Cycle", () => {
  test("byproduct target survives when one producer is in a zero-output SCC", () => {
    // Three targets: Copper Component (30) + Proc Battery (30) + Liquid Sewage (30)
    // The battery chain pulls in the Xircon SCC. The SCC has a 30/min sewage deficit,
    // plus the 30/min sewage target = 60/min external sewage needed.
    // The furnace (also needed for copper_cmpt) supplies all external sewage.
    const plan = calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 },
        { itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 30 },
        { itemId: ItemId.ITEM_LIQUID_SEWAGE, rate: 30 },
      ],
      mockItems,
      byproductSCCRecipes,
      mockFacilities,
    );

    // All three targets should be in the plan
    expect(getItemNode(plan, ItemId.ITEM_LIQUID_SEWAGE).isTarget).toBe(true);
    expect(getItemNode(plan, ItemId.ITEM_COPPER_CMPT).isTarget).toBe(true);
    expect(getItemNode(plan, ItemId.ITEM_PROC_BATTERY_1).isTarget).toBe(true);

    // SCC recipes should have correct facility counts
    const poolB = plan.nodes.get(RecipeId.POOL_XIRANITE_POLY_1);
    if (poolB?.type === "recipe") {
      expect(poolB.facilityCount).toBeCloseTo(1, 5);
    }
    const poolA = plan.nodes.get(RecipeId.POOL_LIQUID_XIRANITE_POLY_1);
    if (poolA?.type === "recipe") {
      expect(poolA.facilityCount).toBeCloseTo(2, 5);
    }

    // Furnace: max(copper_nugget demand=30/rate=30, sewage demand=60/rate=30) = 2 facilities
    const furnace = plan.nodes.get(RecipeId.FURNANCE_COPPER_NUGGET_1);
    if (furnace?.type === "recipe") {
      expect(furnace.facilityCount).toBeCloseTo(2, 5);
    }
  });

  test("byproduct produced by multiple recipes has summed rate", () => {
    // Two targets: Copper Component (30) + Proc Battery (30)
    // The battery chain pulls in the Xircon SCC (pool_xiranite_poly_1 produces 30/min sewage).
    // The furnace (for copper_nugget) also produces 30/min sewage.
    // Total sewage production = 60/min (30 from SCC + 30 from furnace).
    const plan = calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 },
        { itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 30 },
      ],
      mockItems,
      byproductSCCRecipes,
      mockFacilities,
    );

    // Sewage produced by both furnace (30/min) and pool_xiranite_poly_1 (30/min)
    const sewageNode = getItemNode(plan, ItemId.ITEM_LIQUID_SEWAGE);
    // Total production = 60/min (but 60/min is also consumed by the SCC cycle, so net = 0)
    expect(sewageNode.productionRate).toBeCloseTo(60, 5);
  });
});

describe("Disposal Recipes", () => {
  test("injects disposal when byproduct has no consumers", () => {
    // Target: Copper Component → produces Sewage as byproduct with no consumer
    // Expected: Disposal recipe injected for the full 30/min surplus
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      mockItems,
      byproductRecipes,
      mockFacilities,
    );

    // Disposal recipe should be in the plan
    const disposalRecipeId =
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE;
    expect(plan.nodes.has(disposalRecipeId)).toBe(true);

    const disposalNode = plan.nodes.get(disposalRecipeId)!;
    expect(disposalNode.type).toBe("recipe");
    if (disposalNode.type === "recipe") {
      expect(disposalNode.isDisposal).toBe(true);
      expect(disposalNode.facilityCount).toBeCloseTo(1, 5); // 30/min surplus / 30/min per facility
    }
  });

  test("does not inject disposal when byproduct is a target", () => {
    // Target: Copper Component + Liquid Sewage (as target)
    // Sewage target demand equals production → no surplus → no disposal
    const plan = calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 },
        { itemId: ItemId.ITEM_LIQUID_SEWAGE, rate: 30 },
      ],
      mockItems,
      byproductRecipes,
      mockFacilities,
    );

    const disposalRecipeId =
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE;
    expect(plan.nodes.has(disposalRecipeId)).toBe(false);
  });

  test("injects disposal only for surplus when byproduct is partially targeted", () => {
    // Target: Copper Component (rate 60 → 2 furnaces → 60/min sewage)
    //       + Liquid Sewage target at 30/min
    // Surplus = 60 - 30 = 30/min → 1 disposal facility
    const plan = calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_COPPER_CMPT, rate: 60 },
        { itemId: ItemId.ITEM_LIQUID_SEWAGE, rate: 30 },
      ],
      mockItems,
      byproductRecipes,
      mockFacilities,
    );

    const disposalRecipeId =
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE;
    expect(plan.nodes.has(disposalRecipeId)).toBe(true);

    const disposalNode = plan.nodes.get(disposalRecipeId)!;
    if (disposalNode.type === "recipe") {
      expect(disposalNode.facilityCount).toBeCloseTo(1, 5); // 30/min surplus / 30/min per facility
    }
  });

  test("disposal facility count scales with surplus", () => {
    // Target: Copper Component at rate 90 → 3 furnaces → 90/min sewage
    // No consumer or target for sewage → full disposal
    // Expected: 3 disposal facilities (90/30 = 3)
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 90 }],
      mockItems,
      byproductRecipes,
      mockFacilities,
    );

    const disposalRecipeId =
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE;
    expect(plan.nodes.has(disposalRecipeId)).toBe(true);

    const disposalNode = plan.nodes.get(disposalRecipeId)!;
    if (disposalNode.type === "recipe") {
      expect(disposalNode.facilityCount).toBeCloseTo(3, 5);
    }
  });

  test("disposal has correct edges in production graph", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      mockItems,
      byproductRecipes,
      mockFacilities,
    );

    const disposalRecipeId =
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE;

    // Edge from sewage item to disposal recipe (consumption)
    const consumptionEdge = plan.edges.find(
      (e) =>
        e.from === ItemId.ITEM_LIQUID_SEWAGE && e.to === disposalRecipeId,
    );
    expect(consumptionEdge).toBeDefined();

    // No edge from disposal recipe to any item (it produces nothing)
    const productionEdge = plan.edges.find(
      (e) => e.from === disposalRecipeId,
    );
    expect(productionEdge).toBeUndefined();
  });
});

describe("Stress Tests", () => {
  test("handles deeply nested dependency chain", () => {
    const items = Array.from({ length: 11 }, (_, i) => ({
      id: `ITEM_LEVEL_${i}` as ItemId,
      tier: i,
    }));
    const recipes = Array.from({ length: 10 }, (_, i) => ({
      id: `RECIPE_LEVEL_${i}` as RecipeId,
      inputs: [{ itemId: items[i].id, amount: 1 }],
      outputs: [{ itemId: items[i + 1].id, amount: 1 }],
      facilityId: mockFacilities[0].id,
      craftingTime: 2,
    }));

    const plan = calculateProductionPlan(
      [{ itemId: items[10].id, rate: 30 }],
      items,
      recipes,
      mockFacilities,
    );

    let currentId: string = items[10].id;
    let depth = 0;

    while (true) {
      const producer = getProducer(plan, currentId as ItemId);
      if (!producer) break;
      depth++;
      const inputs = getRecipeInputs(plan, producer.recipeId);
      if (inputs.length === 0) break;
      currentId = inputs[0];
    }

    expect(depth).toBe(10);
  });
});

describe("Xircon Production Chain", () => {
  // Rate D = 30/min. Per facility rates are 30/min (craftingTime=2, amount=1).
  // Expected facility counts for D=30: all recipes need 1.0 except
  // pool_liquid_xiranite_poly_1 which needs 2.0 (produces 1 per cycle,
  // but 2 liquid_xiranite_poly are consumed per xiranite_poly).
  const D = 30;

  test("produces xiranite_poly with correct facility counts", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: D }],
      mockItems,
      xirconRecipes,
      mockFacilities,
    );

    // Xiranite Poly is in the plan as a target
    expect(plan.nodes.has(ItemId.ITEM_XIRANITE_POLY)).toBe(true);
    const xirconNode = getItemNode(plan, ItemId.ITEM_XIRANITE_POLY);
    expect(xirconNode.isTarget).toBe(true);
    expect(xirconNode.productionRate).toBeCloseTo(D, 5);

    // pool_xiranite_poly_1: produces 1 xiranite_poly per cycle → 1 facility for 30/min
    const poolB = plan.nodes.get(RecipeId.POOL_XIRANITE_POLY_1);
    expect(poolB).toBeDefined();
    if (poolB?.type === "recipe") {
      expect(poolB.facilityCount).toBeCloseTo(1, 5);
    }

    // pool_liquid_xiranite_poly_1: needs 2 facilities (2 liquid_xiranite_poly consumed per xiranite_poly)
    const poolA = plan.nodes.get(RecipeId.POOL_LIQUID_XIRANITE_POLY_1);
    expect(poolA).toBeDefined();
    if (poolA?.type === "recipe") {
      expect(poolA.facilityCount).toBeCloseTo(2, 5);
    }
  });

  test("includes external sewage source for cycle deficit", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: D }],
      mockItems,
      xirconRecipes,
      mockFacilities,
    );

    // furnance_copper_nugget_1 must be in the plan as external sewage source
    const furnace = plan.nodes.get(RecipeId.FURNANCE_COPPER_NUGGET_1);
    expect(furnace).toBeDefined();
    if (furnace?.type === "recipe") {
      // Deficit is D/min sewage → 1 facility at 30/min
      expect(furnace.facilityCount).toBeCloseTo(1, 5);
    }

    // Copper nugget appears as unwanted byproduct
    expect(plan.nodes.has(ItemId.ITEM_COPPER_NUGGET)).toBe(true);
  });

  test("liquid_xiranite_lowpoly surplus is disposed", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: D }],
      mockItems,
      xirconRecipes,
      mockFacilities,
    );

    // 2 facilities of pool_liquid_xiranite_poly_1 produce 2D lowpoly → disposal needed
    const disposalId =
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_XIRANITE_LOWPOLY;
    expect(plan.nodes.has(disposalId)).toBe(true);
    const disposal = plan.nodes.get(disposalId)!;
    if (disposal.type === "recipe") {
      expect(disposal.isDisposal).toBe(true);
      // 2D=60 surplus / 30 per facility = 2 disposal facilities
      expect(disposal.facilityCount).toBeCloseTo(2, 5);
    }
  });

  test("liquid_sewage is fully consumed with no disposal needed", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: D }],
      mockItems,
      xirconRecipes,
      mockFacilities,
    );

    // Sewage: produced 2D (1D from pool_xiranite_poly_1 + 1D from furnace),
    // consumed 2D (by pool_liquid_xiranite_poly_1 running at 2 facilities).
    // No surplus → no disposal.
    const sewageDisposalId =
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE;
    expect(plan.nodes.has(sewageDisposalId)).toBe(false);
  });

  test("upstream recipes have correct facility counts", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: D }],
      mockItems,
      xirconRecipes,
      mockFacilities,
    );

    // pool_liquid_liquid_xiranite_1: 2 facilities (feeds 2 pool_liquid_xiranite_poly_1)
    const liquidXiranite = plan.nodes.get(
      RecipeId.POOL_LIQUID_LIQUID_XIRANITE_1,
    );
    expect(liquidXiranite).toBeDefined();
    if (liquidXiranite?.type === "recipe") {
      expect(liquidXiranite.facilityCount).toBeCloseTo(2, 5);
    }

    // xiranite_oven: 2 facilities (feeds pool_liquid_liquid_xiranite_1)
    const oven = plan.nodes.get(RecipeId.XIRANITE_OVEN_XIRANITE_POWDER_1);
    expect(oven).toBeDefined();
    if (oven?.type === "recipe") {
      expect(oven.facilityCount).toBeCloseTo(2, 5);
    }
  });

  test("dual target: xircon + sewage produces correct facility counts", () => {
    // When both xiranite_poly AND liquid_sewage are targets, the SCC deficit
    // (30/min) plus the sewage target (30/min) means the furnace must supply
    // 60/min total → 2 facilities. The deficit must not double-count the
    // target demand that's already included in the SCC's external demand.
    const plan = calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_XIRANITE_POLY, rate: D },
        { itemId: ItemId.ITEM_LIQUID_SEWAGE, rate: D },
      ],
      mockItems,
      xirconRecipes,
      mockFacilities,
    );

    // Both targets should be in the plan
    expect(getItemNode(plan, ItemId.ITEM_XIRANITE_POLY).isTarget).toBe(true);
    expect(getItemNode(plan, ItemId.ITEM_LIQUID_SEWAGE).isTarget).toBe(true);

    // SCC recipes: same facility counts as single-target case
    const poolB = plan.nodes.get(RecipeId.POOL_XIRANITE_POLY_1);
    if (poolB?.type === "recipe") {
      expect(poolB.facilityCount).toBeCloseTo(1, 5);
    }

    const poolA = plan.nodes.get(RecipeId.POOL_LIQUID_XIRANITE_POLY_1);
    if (poolA?.type === "recipe") {
      expect(poolA.facilityCount).toBeCloseTo(2, 5);
    }

    // Furnace: 60/min sewage needed (30 deficit + 30 target) → 2 facilities
    const furnace = plan.nodes.get(RecipeId.FURNANCE_COPPER_NUGGET_1);
    expect(furnace).toBeDefined();
    if (furnace?.type === "recipe") {
      expect(furnace.facilityCount).toBeCloseTo(2, 5);
    }

    // No sewage disposal — all sewage is consumed by cycle or targeted
    const sewageDisposalId =
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE;
    expect(plan.nodes.has(sewageDisposalId)).toBe(false);
  });
});

describe("Real 1.2 data regression", () => {
  test("xiranite_enr_powder produces complete chain with no invalid cycles", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_ENR_POWDER, rate: 6 }],
      items,
      recipes,
      facilities,
    );
    expect(plan.invalidCycles).toEqual([]);

    const target = plan.nodes.get(ItemId.ITEM_XIRANITE_ENR_POWDER);
    expect(target?.type).toBe("item");
    if (target?.type === "item") {
      expect(target.productionRate).toBeGreaterThanOrEqual(6);
    }

    const powderRecipe = plan.nodes.get(RecipeId.XIRANITE_OVEN_XIRANITE_POWDER_1);
    expect(powderRecipe?.type).toBe("recipe");
    if (powderRecipe?.type === "recipe") {
      expect(powderRecipe.facilityCount).toBeGreaterThan(0);
    }

    const mossGrinder = plan.nodes.get(RecipeId.GRINDER_PLANT_MOSS_POWDER_1_1);
    expect(mossGrinder).toBeDefined();
    expect(mossGrinder?.type).toBe("recipe");
    if (mossGrinder?.type === "recipe") {
      expect(mossGrinder.facilityCount).toBeGreaterThan(0);
    }
  });

  test("copper_enr + xiranite_poly multi-target does not inflate water consumption", () => {
    const plan = calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_COPPER_ENR, rate: 5 },
        { itemId: ItemId.ITEM_XIRANITE_POLY, rate: 5 },
      ],
      items,
      recipes,
      facilities,
    );
    expect(plan.invalidCycles).toEqual([]);

    const water = plan.nodes.get(ItemId.ITEM_LIQUID_WATER);
    expect(water?.type).toBe("item");
    // Pre-fix multi-target blowup produced 60/min; combined demand with the
    // byproduct-recovery recipe preserved must stay sub-additive vs the two
    // single-target plans (A=40, B=17, sum=57).
    if (water?.type === "item") {
      expect(water.productionRate).toBeLessThanOrEqual(57);
    }

    expect(
      plan.nodes.has(RecipeId.LIQUID_PURIFIER_XIRANITE_POLY_1),
    ).toBe(true);
  });
});

describe("Issue #68 — Xiranite over-production", () => {
  test("Xiranite powder production matches summed consumer demand", () => {
    const targets = [
      { itemId: ItemId.ITEM_PROC_BATTERY_5, rate: 11.5 },
      { itemId: ItemId.ITEM_BOTTLED_REC_HP_5, rate: 1 },
      { itemId: ItemId.ITEM_EQUIP_SCRIPT_4_2, rate: 1 },
      { itemId: ItemId.ITEM_COPPER_ENR_CMPT, rate: 2 },
      { itemId: ItemId.ITEM_XIRANITE_ENR_POWDER, rate: 3 },
      { itemId: ItemId.ITEM_EQUIP_SCRIPT_4, rate: 1 },
      { itemId: ItemId.ITEM_EQUIP_SCRIPT_4_1, rate: 1.5 },
      { itemId: ItemId.ITEM_COPPER_CMPT, rate: 2.5 },
      { itemId: ItemId.ITEM_COPPER_BOTTLE, rate: 1.25 },
      { itemId: ItemId.ITEM_XIRANITE_POWDER, rate: 8 },
      { itemId: ItemId.ITEM_LIQUID_XIRANITE, rate: 1 },
      { itemId: ItemId.ITEM_LIQUID_XIRANITE_ENR, rate: 1 },
    ];

    const plan = calculateProductionPlan(
      targets,
      items,
      recipes,
      facilities,
    );

    const powder = plan.nodes.get(ItemId.ITEM_XIRANITE_POWDER);
    expect(powder?.type).toBe("item");
    if (powder?.type !== "item") return;

    const targetMap = new Map(targets.map((t) => [t.itemId, t.rate]));
    const targetRate = targetMap.get(ItemId.ITEM_XIRANITE_POWDER) ?? 0;

    // consumer demand = sum over each recipe consuming xiranite powder of
    //                   calcRate(input.amount, t) * facilityCount
    let consumerDemand = 0;
    for (const edge of plan.edges) {
      if (edge.from !== ItemId.ITEM_XIRANITE_POWDER) continue;
      const consumer = plan.nodes.get(edge.to);
      if (consumer?.type !== "recipe") continue;
      const input = consumer.recipe.inputs.find(
        (i) => i.itemId === ItemId.ITEM_XIRANITE_POWDER,
      );
      if (!input) continue;
      consumerDemand +=
        calcRate(input.amount, consumer.recipe.craftingTime) *
        consumer.facilityCount;
    }

    const totalDemand = targetRate + consumerDemand;

    expect(powder.productionRate).toBeCloseTo(totalDemand, 3);
  });
});
