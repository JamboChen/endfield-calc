import { describe, test, expect } from "vitest";
import { mergeItemNodes } from "@/hooks/useProductionTable";
import type {
  ProductionDependencyGraph,
  ProductionGraphNode,
  ItemId,
  RecipeId,
  Item,
  Recipe,
  Facility,
} from "@/types";

/**
 * Mixed-strategy table rendering tests.
 *
 * Why these matter even though the global LP doesn't currently produce
 * mixed strategies on real data: the table-side `mergeItemNodes` must
 * handle the case correctly for when raw-material capacity constraints
 * eventually land (the only known trigger for genuine mixed-strategy
 * LP outputs). These synthetic-plan tests pin the rendering contract
 * so the support doesn't bit-rot.
 *
 * See `src/lib/flow-solver.ts:detectMixedStrategies` for the dev-mode
 * runtime telemetry on the same condition.
 */

const item = (id: string): Item => ({
  id: id as ItemId,
  tier: 1,
});

const recipe = (
  id: string,
  inputId: string,
  outputId: string,
): Recipe => ({
  id: id as RecipeId,
  inputs: [{ itemId: inputId as ItemId, amount: 1 }],
  outputs: [{ itemId: outputId as ItemId, amount: 1 }],
  facilityId: "fac" as Facility["id"],
  craftingTime: 2,
});

const facility: Facility = {
  id: "fac" as Facility["id"],
  numId: 0,
  powerConsumption: 10,
  tier: 1,
  category: 0,
  buffersIn: { belt: [], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
  cap: null,
};

/**
 * Build a synthetic plan with two recipes producing the same item at
 * non-zero facility counts (a mixed-strategy LP output).
 */
function buildMixedStrategyPlan(): ProductionDependencyGraph {
  const itemX = item("x");
  const itemRaw = item("raw");

  const recipeA = recipe("recipe_a", "raw", "x");
  const recipeB = recipe("recipe_b", "raw", "x");

  const nodes = new Map<string, ProductionGraphNode>();
  nodes.set("x", {
    type: "item",
    itemId: "x" as ItemId,
    item: itemX,
    productionRate: 60,
    isRawMaterial: false,
    isTarget: true,
  });
  nodes.set("raw", {
    type: "item",
    itemId: "raw" as ItemId,
    item: itemRaw,
    productionRate: 60,
    isRawMaterial: true,
    isTarget: false,
  });
  // recipe_a runs at 0.4 facilities; recipe_b runs at 0.6 facilities.
  // Together they produce 60/min of item_x.
  nodes.set("recipe_a", {
    type: "recipe",
    recipeId: "recipe_a" as RecipeId,
    recipe: recipeA,
    facility,
    facilityCount: 0.4,
    isDisposal: false,
    binId: undefined,
    binSisterRecipeIds: [],
    prefillCandidates: [],
  });
  nodes.set("recipe_b", {
    type: "recipe",
    recipeId: "recipe_b" as RecipeId,
    recipe: recipeB,
    facility,
    facilityCount: 0.6,
    isDisposal: false,
    binId: undefined,
    binSisterRecipeIds: [],
    prefillCandidates: [],
  });

  const edges = [
    { from: "raw", to: "recipe_a" },
    { from: "raw", to: "recipe_b" },
    { from: "recipe_a", to: "x" },
    { from: "recipe_b", to: "x" },
  ];

  return {
    nodes,
    edges,
    targets: new Set(["x" as ItemId]),
    detectedCycles: [],
    invalidCycles: [],
    bins: [],
    recipeBinAllocations: new Map(),
    warnings: [],
  };
}

describe("mergeItemNodes mixed-strategy handling", () => {
  test("aggregates facility counts across multiple active producers", () => {
    const plan = buildMixedStrategyPlan();
    const merged = mergeItemNodes(plan, new Map());
    const xNode = merged.get("x" as ItemId);
    expect(xNode).toBeDefined();
    expect(xNode!.producers.length).toBe(2);
    // Total facility count = sum of all producers (0.4 + 0.6 = 1.0).
    expect(xNode!.totalFacilityCount).toBeCloseTo(1.0, 5);
  });

  test("picks the dominant (highest-fc) producer for the dropdown's recipeId", () => {
    const plan = buildMixedStrategyPlan();
    const merged = mergeItemNodes(plan, new Map());
    const xNode = merged.get("x" as ItemId);
    // recipe_b has fc=0.6, recipe_a has fc=0.4 → b dominates.
    expect(xNode!.recipeId).toBe("recipe_b");
  });

  test("user override beats the dominant-fc heuristic when override is an active producer", () => {
    const plan = buildMixedStrategyPlan();
    // User pins recipe_a even though recipe_b has higher facility count.
    const overrides = new Map([["x" as ItemId, "recipe_a" as RecipeId]]);
    const merged = mergeItemNodes(plan, overrides);
    expect(merged.get("x" as ItemId)!.recipeId).toBe("recipe_a");
  });

  test("override that isn't an active producer falls back to dominant-fc", () => {
    const plan = buildMixedStrategyPlan();
    // User pins recipe_c which doesn't exist in the plan; should fall
    // back to dominant heuristic (recipe_b).
    const overrides = new Map([["x" as ItemId, "recipe_c" as RecipeId]]);
    const merged = mergeItemNodes(plan, overrides);
    expect(merged.get("x" as ItemId)!.recipeId).toBe("recipe_b");
  });

  test("producers list preserves both entries with their facility counts", () => {
    const plan = buildMixedStrategyPlan();
    const merged = mergeItemNodes(plan, new Map());
    const xNode = merged.get("x" as ItemId);
    const a = xNode!.producers.find(
      (p) => p.recipeId === ("recipe_a" as RecipeId),
    );
    const b = xNode!.producers.find(
      (p) => p.recipeId === ("recipe_b" as RecipeId),
    );
    expect(a?.facilityCount).toBeCloseTo(0.4, 5);
    expect(b?.facilityCount).toBeCloseTo(0.6, 5);
  });

  test("single-producer item (the common case) has producers.length === 1", () => {
    // Same shape as the mixed test, but only one active producer.
    const plan = buildMixedStrategyPlan();
    // Zero out recipe_a's facility count → no longer an active producer.
    const recipeA = plan.nodes.get("recipe_a")!;
    if (recipeA.type === "recipe") recipeA.facilityCount = 0;

    const merged = mergeItemNodes(plan, new Map());
    const xNode = merged.get("x" as ItemId);
    expect(xNode!.producers.length).toBe(1);
    expect(xNode!.producers[0].recipeId).toBe("recipe_b");
    expect(xNode!.totalFacilityCount).toBeCloseTo(0.6, 5);
    expect(xNode!.recipeId).toBe("recipe_b");
  });

  test("dependencies union across all active producers", () => {
    // Build a plan where two producers consume different inputs.
    const recipeA: Recipe = {
      id: "recipe_a" as RecipeId,
      inputs: [{ itemId: "raw_a" as ItemId, amount: 1 }],
      outputs: [{ itemId: "x" as ItemId, amount: 1 }],
      facilityId: "fac" as Facility["id"],
      craftingTime: 2,
    };
    const recipeB: Recipe = {
      id: "recipe_b" as RecipeId,
      inputs: [{ itemId: "raw_b" as ItemId, amount: 1 }],
      outputs: [{ itemId: "x" as ItemId, amount: 1 }],
      facilityId: "fac" as Facility["id"],
      craftingTime: 2,
    };

    const nodes = new Map<string, ProductionGraphNode>();
    nodes.set("x", {
      type: "item",
      itemId: "x" as ItemId,
      item: item("x"),
      productionRate: 60,
      isRawMaterial: false,
      isTarget: true,
    });
    nodes.set("raw_a", {
      type: "item",
      itemId: "raw_a" as ItemId,
      item: item("raw_a"),
      productionRate: 12,
      isRawMaterial: true,
      isTarget: false,
    });
    nodes.set("raw_b", {
      type: "item",
      itemId: "raw_b" as ItemId,
      item: item("raw_b"),
      productionRate: 18,
      isRawMaterial: true,
      isTarget: false,
    });
    nodes.set("recipe_a", {
      type: "recipe",
      recipeId: "recipe_a" as RecipeId,
      recipe: recipeA,
      facility,
      facilityCount: 0.4,
      isDisposal: false,
      binId: undefined,
      binSisterRecipeIds: [],
      prefillCandidates: [],
    });
    nodes.set("recipe_b", {
      type: "recipe",
      recipeId: "recipe_b" as RecipeId,
      recipe: recipeB,
      facility,
      facilityCount: 0.6,
      isDisposal: false,
      binId: undefined,
      binSisterRecipeIds: [],
      prefillCandidates: [],
    });

    const plan: ProductionDependencyGraph = {
      nodes,
      edges: [
        { from: "raw_a", to: "recipe_a" },
        { from: "raw_b", to: "recipe_b" },
        { from: "recipe_a", to: "x" },
        { from: "recipe_b", to: "x" },
      ],
      targets: new Set(["x" as ItemId]),
      detectedCycles: [],
      invalidCycles: [],
      bins: [],
      recipeBinAllocations: new Map(),
      warnings: [],
    };

    const merged = mergeItemNodes(plan, new Map());
    const xNode = merged.get("x" as ItemId);
    // Should depend on BOTH raw_a and raw_b (union of producer inputs).
    expect(xNode!.dependencies.has("raw_a" as ItemId)).toBe(true);
    expect(xNode!.dependencies.has("raw_b" as ItemId)).toBe(true);
  });
});
