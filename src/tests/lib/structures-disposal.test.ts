/**
 * Structures wiring (Sewage Inlet + Byproduct Outlet).
 *
 * Covers the LP-aware disposal model with the new facility cap and the
 * data-driven variant toggle. All tests use the real `items` / `recipes`
 * / `facilities` data so the test set doubles as a regression guard for
 * the upstream Sewage chain.
 */
import { describe, expect, test } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { items, recipes, facilities, rawMaterialSources } from "@/data";
import { calcRate } from "@/lib/utils";
import { FacilityId, ItemId, RecipeId } from "@/types/constants";
import type { ProductionGraphNode } from "@/types";

const ALL_RAWS: ReadonlySet<ItemId> = new Set(rawMaterialSources.keys());

// Sewage Inlet per-building throughput (in sewage/min). Derived from the
// recipe data so the test stays in sync if the rates ever change.
const DISPOSAL_RECIPE = recipes.find(
  (r) => r.id === RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL,
)!;
const BYPRODUCT_RECIPE = recipes.find(
  (r) => r.id === RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT,
)!;
const SEWAGE_PER_INLET_PER_MIN = calcRate(
  DISPOSAL_RECIPE.inputs[0].amount,
  DISPOSAL_RECIPE.craftingTime,
);
const SEWAGE_PER_BYPRODUCT_PER_MIN = calcRate(
  BYPRODUCT_RECIPE.inputs[0].amount,
  BYPRODUCT_RECIPE.craftingTime,
);
const XIRANITE_POLY_PER_BYPRODUCT_PER_MIN = calcRate(
  BYPRODUCT_RECIPE.outputs[0].amount,
  BYPRODUCT_RECIPE.craftingTime,
);
// Liquid Cleaner sewage disposal rate (canonical Water Treatment Unit).
const CLEANER_RECIPE = recipes.find(
  (r) => r.id === RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
)!;
const SEWAGE_PER_CLEANER_PER_MIN = calcRate(
  CLEANER_RECIPE.inputs[0].amount,
  CLEANER_RECIPE.craftingTime,
);

const recipeNode = (
  plan: { nodes: ReadonlyMap<string, ProductionGraphNode> },
  recipeId: RecipeId,
) => {
  const node = plan.nodes.get(recipeId);
  if (!node || node.type !== "recipe") return undefined;
  return node;
};

describe("Sewage Inlet — facility cap drives LP variant selection", () => {
  // Sanity-check the recipe constants extracted above (guards against
  // upstream rate changes silently re-tuning the test).
  test("recipe constants match the in-game numbers", () => {
    expect(SEWAGE_PER_INLET_PER_MIN).toBe(120);
    expect(SEWAGE_PER_BYPRODUCT_PER_MIN).toBe(120);
    expect(XIRANITE_POLY_PER_BYPRODUCT_PER_MIN).toBe(4);
    expect(SEWAGE_PER_CLEANER_PER_MIN).toBe(30);
  });

  test("no facilityCaps: LIQUID_CLEAN_GATE_1 variants are excluded; Liquid Cleaner absorbs sewage", async () => {
    // Target: 1 Cuprium part (drives furnace, byproduct = 30 sewage/min).
    // Without a LIQUID_CLEAN_GATE_1 cap, the calculator filters both variants
    // out so the LP only sees `liquid_cleaner_1` for disposal.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
    );

    expect(recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL)).toBeUndefined();
    expect(recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT)).toBeUndefined();

    const cleaner = recipeNode(
      plan,
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
    );
    expect(cleaner).toBeDefined();
    expect(cleaner!.facilityCount).toBeCloseTo(
      30 / SEWAGE_PER_CLEANER_PER_MIN,
      5,
    );
  });

  test("cap=3 (inlets enabled, outlet OFF): LP picks Sewage Inlet over Liquid Cleaner up to cap", async () => {
    // Sewage Inlet has powerConsumption=0 vs Liquid Cleaner's 50W.
    // With sewage byproduct ≤ 3×120 = 360/min, the LP should pick Inlet
    // exclusively (lower power wins pass 3 of the lex objective; the
    // building cost is equal at 1 per facility).
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      items,
      recipes,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 3]]),
      },
    );

    const inlet = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL);
    expect(inlet).toBeDefined();
    // 30/min sewage / 120/min/building = 0.25 buildings.
    expect(inlet!.facilityCount).toBeCloseTo(
      30 / SEWAGE_PER_INLET_PER_MIN,
      5,
    );

    // Liquid Cleaner stays at zero (LP preferred the free disposer).
    const cleaner = recipeNode(
      plan,
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
    );
    expect(cleaner).toBeUndefined();
  });

  test("cap-binding: surplus above 3×120/min spills to Liquid Cleaner", async () => {
    // Target: 30 Cuprium parts/min → 30 furnaces → 900/min sewage byproduct.
    // 3 Sewage Inlets at 120/min cover 360/min; remaining 540/min must
    // route through Liquid Cleaner (540/30 = 18 buildings).
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 900 }],
      items,
      recipes,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 3]]),
      },
    );

    const inlet = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL);
    expect(inlet).toBeDefined();
    // LP fills Sewage Inlet exactly to its cap (3 buildings ≈ 360/min).
    expect(inlet!.facilityCount).toBeCloseTo(3, 5);

    const cleaner = recipeNode(
      plan,
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
    );
    expect(cleaner).toBeDefined();
    // (900 − 360) / 30 = 18 Liquid Cleaner buildings.
    expect(cleaner!.facilityCount).toBeCloseTo(18, 5);
  });

  test("cap=3 with Byproduct Outlet enabled: LP uses BYPRODUCT variant (not DISPOSAL)", async () => {
    // The test caller models the App-side variant filter by passing only
    // the BYPRODUCT recipe through `recipes` (App filters out the
    // inactive variant before handing the list to the calculator).
    const filteredRecipes = recipes.filter(
      (r) => r.id !== RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL,
    );

    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      items,
      filteredRecipes,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 3]]),
      },
    );

    const byproduct = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT);
    expect(byproduct).toBeDefined();
    // 30/min sewage / 120/min/building = 0.25 buildings.
    expect(byproduct!.facilityCount).toBeCloseTo(0.25, 5);

    // Disposal variant must NOT appear (it was filtered out upstream).
    expect(recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL)).toBeUndefined();
  });

  test("byproduct variant emits xiranite_poly at the 30:1 ratio (4/min/building)", async () => {
    // 30/min sewage byproduct × (4 xiranite_poly / 120 sewage) = 1/min
    // xiranite_poly produced as a side-effect of disposal. With no
    // downstream consumer of xiranite_poly, the LP routes it through
    // the xiranite_poly disposal recipe (Liquid Cleaner variant).
    const filteredRecipes = recipes.filter(
      (r) => r.id !== RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL,
    );

    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      items,
      filteredRecipes,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 3]]),
      },
    );

    const byproduct = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT);
    expect(byproduct).toBeDefined();
    const xiranitePolyProduced =
      byproduct!.facilityCount * XIRANITE_POLY_PER_BYPRODUCT_PER_MIN;
    // 0.25 × 4 = 1 xiranite_poly/min.
    expect(xiranitePolyProduced).toBeCloseTo(1, 5);

    // Cascading: xiranite_poly disposal must also be in the plan to
    // absorb the side-output (forced-disposal item with a consumer).
    const xpDisposal = recipeNode(
      plan,
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_XIRANITE_POLY,
    );
    expect(xpDisposal).toBeDefined();
    expect(xpDisposal!.facilityCount).toBeCloseTo(1 / 30, 4);
  });

  test("cap=0 (absent entry): variants treated as unavailable even if recipes array includes them", async () => {
    // Defensive: facilityCaps entry with value 0 is the same as not
    // setting it (both treated as "no instances enabled"). Without this
    // the LP could use the LIQUID_CLEAN_GATE_1 recipes freely with no upper
    // bound, contradicting the user's intent.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      items,
      recipes,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 0]]),
      },
    );

    expect(recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL)).toBeUndefined();
    expect(recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT)).toBeUndefined();

    // Liquid Cleaner still does the work.
    const cleaner = recipeNode(
      plan,
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
    );
    expect(cleaner).toBeDefined();
  });
});

describe("Sewage Inlet — LP facility cap enforcement is hard", () => {
  test("cap=1: LP never runs more than 1 Sewage Inlet building", async () => {
    // Target: 4 Cuprium parts/min → 120/min sewage.
    // 1 Sewage Inlet = 120/min capacity → exactly matches.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 120 }],
      items,
      recipes,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 1]]),
      },
    );

    const inlet = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL);
    expect(inlet).toBeDefined();
    expect(inlet!.facilityCount).toBeCloseTo(1, 5);

    // No spillover needed (cap exactly matches demand).
    const cleaner = recipeNode(
      plan,
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
    );
    expect(cleaner).toBeUndefined();
  });

  test("cap=1 overflow: LP routes excess to Liquid Cleaner (LP-level cap enforcement)", async () => {
    // Target: 5 Cuprium parts/min → 150/min sewage.
    // Cap=1 → Sewage Inlet covers 120/min, 30/min spills to Cleaner.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 150 }],
      items,
      recipes,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 1]]),
      },
    );

    const inlet = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL);
    expect(inlet).toBeDefined();
    expect(inlet!.facilityCount).toBeCloseTo(1, 5);

    const cleaner = recipeNode(
      plan,
      RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
    );
    expect(cleaner).toBeDefined();
    expect(cleaner!.facilityCount).toBeCloseTo(1, 5); // 30/30 = 1 building
  });
});

describe("Sewage Inlet — rendering hooks", () => {
  test("DISPOSAL variant is rendered as a disposal sink (outputs.length === 0)", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      items,
      recipes,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 3]]),
      },
    );

    const inlet = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL);
    expect(inlet).toBeDefined();
    expect(inlet!.isDisposal).toBe(true);
    expect(inlet!.recipe.outputs.length).toBe(0);
  });

  test("BYPRODUCT variant is rendered as a producer (NOT a disposal sink)", async () => {
    const filteredRecipes = recipes.filter(
      (r) => r.id !== RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL,
    );

    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      items,
      filteredRecipes,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 3]]),
      },
    );

    const byproduct = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT);
    expect(byproduct).toBeDefined();
    expect(byproduct!.isDisposal).toBe(false);
    expect(byproduct!.recipe.outputs.length).toBe(1);
    expect(byproduct!.recipe.outputs[0].itemId).toBe(
      ItemId.ITEM_LIQUID_XIRANITE_POLY,
    );
  });
});

describe("Sewage Inlet — LP constraint fallback for orphan forced-disposal items", () => {
  // Load-bearing branch in `flow-solver.ts`: forced-disposal items WITH a
  // consumer in the graph get strict-equality slack semantics; items
  // WITHOUT a consumer fall back to plain `min: 0` (the historical
  // behaviour for dead-end byproducts). Without this fallback, the LP
  // would engage surplus-slack on every byproduct that lacks any
  // disposer, even when the user clearly doesn't have one — yielding
  // spurious mixed-strategy solutions on tests like the byproductSCC
  // fixtures (caught the first time during the refactor and fixed
  // there). This direct test locks the fallback rather than rely on
  // indirect coverage.

  test("dead-end forced-disposal byproduct: LP runs feasibly with no slack engaged", async () => {
    // Filter out ALL recipes that consume sewage. The chain still
    // produces sewage as a byproduct of FURNANCE_COPPER_NUGGET_1, so
    // sewage enters the graph as a non-raw forced-disposal item.
    // With the "has consumer" check in flow-solver, no consumer in
    // the graph means the constraint falls back to `min: 0` and
    // surplus is permitted without slack engagement.
    //
    // The input-shape filter `!r.inputs.some(...)` is load-bearing:
    // it sweeps up any sewage-consuming productive recipe even if its
    // outputs are entirely forced-disposal (e.g.
    // POOL_LIQUID_XIRANITE_POLY_1/2, which the pre-LP disposal
    // injection would otherwise pull into the graph because its
    // outputs are all forced-disposal items). Without this filter
    // the test would not actually exercise the fallback branch.
    const recipesWithoutSewageConsumers = recipes.filter(
      (r) =>
        // Drop pure sewage disposers
        r.id !== RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE &&
        r.id !== RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL &&
        r.id !== RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT &&
        // Drop ALL sewage-consuming recipes (productive AND disposal-shaped)
        !r.inputs.some((i) => i.itemId === ItemId.ITEM_LIQUID_SEWAGE),
    );

    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 30 }],
      items,
      recipesWithoutSewageConsumers,
      facilities,
      { rawMaterials: ALL_RAWS },
    );

    // Plan is feasible (no invalid cycles).
    expect(plan.invalidCycles).toHaveLength(0);

    // Copper component target achieved at expected rate.
    const cmpt = plan.nodes.get(ItemId.ITEM_COPPER_CMPT);
    expect(cmpt?.type).toBe("item");
    if (cmpt?.type === "item") {
      expect(cmpt.productionRate).toBeCloseTo(30, 5);
    }

    // Sewage produced as byproduct (1 furnace × 30/min) but no
    // disposer in plan — the LP correctly leaves surplus untouched.
    const sewage = plan.nodes.get(ItemId.ITEM_LIQUID_SEWAGE);
    expect(sewage?.type).toBe("item");
    if (sewage?.type === "item") {
      // Production rate matches what the furnace produces; the LP
      // didn't try to artificially balance via slack.
      expect(sewage.productionRate).toBeCloseTo(30, 5);
    }

    // No disposers in plan.
    expect(
      plan.nodes.get(
        RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
      ),
    ).toBeUndefined();
    expect(
      plan.nodes.get(RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL),
    ).toBeUndefined();
  });

  test("LP-side cap binding: plan stays feasible when cap is too small AND no fallback disposer exists", async () => {
    // Construct a scenario where:
    //   - Cuprium component target = 5 × the no-bottleneck rate = 5 × 30 = 150/min
    //   - Sewage produced = 150/min
    //   - LIQUID_CLEAN_GATE_1 capped at 1 (= 120/min disposal capacity)
    //   - Liquid Cleaner removed from the recipe set
    // The LP's strict-equality slack absorbs the 30/min shortfall
    // (slack_sur > 0 internally; reported in disposalSurpluses inside
    // the LP solution but not surfaced as a user warning today).
    // The OBSERVABLE behavior is: plan feasible, no invalid cycles,
    // inlet pegged at cap.
    const recipesWithoutCleanerSewage = recipes.filter(
      (r) =>
        r.id !== RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
    );

    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_CMPT, rate: 150 }],
      items,
      recipesWithoutCleanerSewage,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 1]]),
      },
    );

    // Plan feasible (slack absorbs unbalanced sewage; not surfaced as a
    // user-facing invalid cycle).
    expect(plan.invalidCycles).toHaveLength(0);

    // Inlet pegged at cap (cap = 1 building × 120/min = 120/min disposal).
    const inlet = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL);
    expect(inlet).toBeDefined();
    expect(inlet!.facilityCount).toBeCloseTo(1, 5);

    // Liquid Cleaner is unavailable (filtered out of the recipe set).
    expect(
      plan.nodes.get(
        RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
      ),
    ).toBeUndefined();
  });
});
