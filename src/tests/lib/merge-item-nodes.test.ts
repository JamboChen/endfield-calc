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
 * Row-per-producer merging tests.
 *
 * Under the row-per-producer model, `mergeItemNodes` emits ONE row per
 * `(item, active-producer)` pair. Single-producer items (≥ 99% of
 * plans today) emit exactly one row each — same shape as before the
 * mixed-strategy refactor. Multi-producer items (mixed strategy, only
 * reachable under future raw-cap features) emit one row per producer
 * with that producer's specific facility count, output contribution,
 * and input dependencies.
 *
 * See also: `flow-solver.ts:detectMixedStrategies` for the dev-mode
 * runtime telemetry that flags mixed-strategy LP outputs.
 */

const item = (id: string): Item => ({
  id: id as ItemId,
  tier: 1,
});

const recipe = (
  id: string,
  inputId: string,
  outputId: string,
  outputAmount = 1,
  craftingTime = 2,
): Recipe => ({
  id: id as RecipeId,
  inputs: [{ itemId: inputId as ItemId, amount: 1 }],
  outputs: [{ itemId: outputId as ItemId, amount: outputAmount }],
  facilityId: "fac" as Facility["id"],
  craftingTime,
});

const facility: Facility = {
  id: "fac" as Facility["id"],
  powerConsumption: 10,
  tier: 1,
  category: 0,
  buffersIn: { belt: [], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
};

/**
 * Build a synthetic plan with two recipes producing the same item at
 * non-zero facility counts (a mixed-strategy LP output).
 */
function buildMixedStrategyPlan(): ProductionDependencyGraph {
  const itemX = item("x");
  const itemRaw = item("raw");

  // recipe_a: 1 raw → 1 x (rate 30/min/facility, fc=0.4 → 12 x/min)
  // recipe_b: 1 raw → 1 x (rate 30/min/facility, fc=0.6 → 18 x/min)
  // Combined: 30 x/min — fulfills target of 30.
  const recipeA = recipe("recipe_a", "raw", "x");
  const recipeB = recipe("recipe_b", "raw", "x");

  const nodes = new Map<string, ProductionGraphNode>();
  nodes.set("x", {
    type: "item",
    itemId: "x" as ItemId,
    item: itemX,
    productionRate: 30,
    isRawMaterial: false,
    isTarget: true,
  });
  nodes.set("raw", {
    type: "item",
    itemId: "raw" as ItemId,
    item: itemRaw,
    productionRate: 30,
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

const rowsForItem = (
  rows: ReturnType<typeof mergeItemNodes>,
  itemId: string,
) => rows.filter((r) => r.itemId === itemId);

describe("mergeItemNodes row-per-producer contract", () => {
  test("mixed-strategy item emits one row per active producer", () => {
    const plan = buildMixedStrategyPlan();
    const rows = mergeItemNodes(plan);

    const xRows = rowsForItem(rows, "x");
    expect(xRows.length).toBe(2);

    // Each row references one specific producer recipe; together they
    // cover both active producers.
    const recipeIds = xRows
      .map((r) => r.recipeId)
      .filter((rid): rid is RecipeId => rid !== null)
      .sort();
    expect(recipeIds).toEqual(["recipe_a", "recipe_b"]);
  });

  test("each sister row carries its own facility count, not the sum", () => {
    const plan = buildMixedStrategyPlan();
    const rows = mergeItemNodes(plan);

    const xRows = rowsForItem(rows, "x");
    const a = xRows.find((r) => r.recipeId === ("recipe_a" as RecipeId));
    const b = xRows.find((r) => r.recipeId === ("recipe_b" as RecipeId));
    expect(a?.facilityCount).toBeCloseTo(0.4, 5);
    expect(b?.facilityCount).toBeCloseTo(0.6, 5);
  });

  test("each sister row's producerContribution is its own slice (Option Y)", () => {
    const plan = buildMixedStrategyPlan();
    const rows = mergeItemNodes(plan);

    const xRows = rowsForItem(rows, "x");
    const a = xRows.find((r) => r.recipeId === ("recipe_a" as RecipeId));
    const b = xRows.find((r) => r.recipeId === ("recipe_b" as RecipeId));
    // recipe_a outputs 1 x per 2s = 30/min/facility × 0.4 fc = 12/min
    expect(a?.producerContribution).toBeCloseTo(12, 5);
    // recipe_b: 30/min × 0.6 fc = 18/min
    expect(b?.producerContribution).toBeCloseTo(18, 5);
    // Sum across sisters = item's total output rate (30/min)
    expect(
      (a?.producerContribution ?? 0) + (b?.producerContribution ?? 0),
    ).toBeCloseTo(30, 5);
  });

  test("each sister row's dependencies are its own producer's inputs only", () => {
    // Build a plan where two producers consume different inputs, so the
    // per-row vs union distinction is observable.
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
      productionRate: 30,
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

    const rows = mergeItemNodes(plan);
    const xRows = rowsForItem(rows, "x");
    const a = xRows.find((r) => r.recipeId === ("recipe_a" as RecipeId));
    const b = xRows.find((r) => r.recipeId === ("recipe_b" as RecipeId));

    // Row A's deps include only raw_a (its producer's input).
    expect(a?.dependencies.has("raw_a" as ItemId)).toBe(true);
    expect(a?.dependencies.has("raw_b" as ItemId)).toBe(false);
    // Row B's deps include only raw_b.
    expect(b?.dependencies.has("raw_b" as ItemId)).toBe(true);
    expect(b?.dependencies.has("raw_a" as ItemId)).toBe(false);
  });

  test("single-producer item emits exactly one row", () => {
    const plan = buildMixedStrategyPlan();
    // Zero out recipe_a → only one active producer for x.
    const recipeA = plan.nodes.get("recipe_a")!;
    if (recipeA.type === "recipe") recipeA.facilityCount = 0;

    const rows = mergeItemNodes(plan);
    const xRows = rowsForItem(rows, "x");
    expect(xRows.length).toBe(1);
    expect(xRows[0].recipeId).toBe("recipe_b");
    expect(xRows[0].facilityCount).toBeCloseTo(0.6, 5);
    // Single-producer contribution equals the item's total output rate.
    expect(xRows[0].producerContribution).toBeCloseTo(18, 5);
  });

  test("raw / no-producer item emits one row with recipeId = null", () => {
    const plan = buildMixedStrategyPlan();
    const rows = mergeItemNodes(plan);

    const rawRows = rowsForItem(rows, "raw");
    expect(rawRows.length).toBe(1);
    expect(rawRows[0].recipeId).toBe(null);
    expect(rawRows[0].facilityCount).toBe(0);
    expect(rawRows[0].isRawMaterial).toBe(true);
    // No-producer fallback: contribution = item's reported productionRate
    // (LP-computed net demand for raws).
    expect(rawRows[0].producerContribution).toBeCloseTo(30, 5);
  });

  test("multi-output recipe contributes a row to each of its produced items", () => {
    // A recipe that emits TWO items as outputs. Both items should
    // appear in rows, each attributed to the same producer recipe.
    const multiOutRecipe: Recipe = {
      id: "multi" as RecipeId,
      inputs: [{ itemId: "raw" as ItemId, amount: 1 }],
      outputs: [
        { itemId: "primary" as ItemId, amount: 2 },
        { itemId: "byproduct" as ItemId, amount: 1 },
      ],
      facilityId: "fac" as Facility["id"],
      craftingTime: 2,
    };

    const nodes = new Map<string, ProductionGraphNode>();
    nodes.set("raw", {
      type: "item",
      itemId: "raw" as ItemId,
      item: item("raw"),
      productionRate: 30,
      isRawMaterial: true,
      isTarget: false,
    });
    nodes.set("primary", {
      type: "item",
      itemId: "primary" as ItemId,
      item: item("primary"),
      productionRate: 60,
      isRawMaterial: false,
      isTarget: true,
    });
    nodes.set("byproduct", {
      type: "item",
      itemId: "byproduct" as ItemId,
      item: item("byproduct"),
      productionRate: 30,
      isRawMaterial: false,
      isTarget: false,
    });
    nodes.set("multi", {
      type: "recipe",
      recipeId: "multi" as RecipeId,
      recipe: multiOutRecipe,
      facility,
      facilityCount: 1,
      isDisposal: false,
      binId: undefined,
      binSisterRecipeIds: [],
      prefillCandidates: [],
    });

    const plan: ProductionDependencyGraph = {
      nodes,
      edges: [
        { from: "raw", to: "multi" },
        { from: "multi", to: "primary" },
        { from: "multi", to: "byproduct" },
      ],
      targets: new Set(["primary" as ItemId]),
      detectedCycles: [],
      invalidCycles: [],
      bins: [],
      recipeBinAllocations: new Map(),
      warnings: [],
    };

    const rows = mergeItemNodes(plan);
    const primaryRows = rowsForItem(rows, "primary");
    const byproductRows = rowsForItem(rows, "byproduct");

    expect(primaryRows.length).toBe(1);
    expect(primaryRows[0].recipeId).toBe("multi");
    // 2 primary per 2s = 60/min/fc × 1 fc = 60
    expect(primaryRows[0].producerContribution).toBeCloseTo(60, 5);

    expect(byproductRows.length).toBe(1);
    expect(byproductRows[0].recipeId).toBe("multi");
    // 1 byproduct per 2s = 30/min/fc × 1 fc = 30
    expect(byproductRows[0].producerContribution).toBeCloseTo(30, 5);
  });

  test("inactive producer (fc = 0) does not emit a row", () => {
    const plan = buildMixedStrategyPlan();
    const recipeA = plan.nodes.get("recipe_a")!;
    if (recipeA.type === "recipe") recipeA.facilityCount = 0;

    const rows = mergeItemNodes(plan);
    const xRows = rowsForItem(rows, "x");
    // Only recipe_b is active → only one row for x.
    expect(xRows.length).toBe(1);
    expect(xRows[0].recipeId).toBe("recipe_b");
  });
});
