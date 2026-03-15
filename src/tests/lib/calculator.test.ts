import { describe, test, expect } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
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
  cycleRecipes,
  complexRecipes,
  byproductRecipes,
  byproductSCCRecipes,
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
  test("detects bottle filling/dismantling cycle", () => {
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

    expect(plan.detectedCycles.length).toBeGreaterThan(0);
    const cycle = plan.detectedCycles[0];

    expect(cycle.involvedItemIds).toContain(ItemId.ITEM_FBOTTLE_GLASS_GRASS_1);

    expect(plan.nodes.has(ItemId.ITEM_FBOTTLE_GLASS_GRASS_1)).toBe(true);
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
    // Three targets: Copper Component + Proc Battery + Liquid Sewage
    // Sewage is produced by the copper furnace (non-zero) AND by Pool B (in SCC, zero).
    // The SCC (Pool A ↔ Pool B via Sewage/Intermediate) is a net consumer of Sewage.
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

    // Liquid Sewage must appear in the plan as a target
    expect(plan.nodes.has(ItemId.ITEM_LIQUID_SEWAGE)).toBe(true);
    const sewageNode = getItemNode(plan, ItemId.ITEM_LIQUID_SEWAGE);
    expect(sewageNode.isTarget).toBe(true);

    // Sewage should have non-zero production from the furnace
    expect(sewageNode.productionRate).toBeGreaterThan(0);

    // Copper Component and Battery should also be in the plan
    expect(plan.nodes.has(ItemId.ITEM_COPPER_CMPT)).toBe(true);
    expect(plan.nodes.has(ItemId.ITEM_PROC_BATTERY_1)).toBe(true);
    expect(getItemNode(plan, ItemId.ITEM_COPPER_CMPT).isTarget).toBe(true);
    expect(getItemNode(plan, ItemId.ITEM_PROC_BATTERY_1).isTarget).toBe(true);
  });

  test("byproduct produced by multiple recipes has summed rate", () => {
    // When an item is produced by multiple recipes (furnace + SCC recipe),
    // the production rate should sum contributions from all producers.
    const plan = calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 },
        { itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 30 },
      ],
      mockItems,
      byproductSCCRecipes,
      mockFacilities,
    );

    // Sewage exists in the plan (as byproduct from furnace + SCC recipe)
    expect(plan.nodes.has(ItemId.ITEM_LIQUID_SEWAGE)).toBe(true);
    const sewageNode = getItemNode(plan, ItemId.ITEM_LIQUID_SEWAGE);

    // Rate should be >= furnace contribution (at least 30/min from 1 furnace)
    // The SCC may add additional production (or 0 if clamped)
    expect(sewageNode.productionRate).toBeGreaterThanOrEqual(30);
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
