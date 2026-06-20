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
import { computeVariantExclusions } from "@/lib/variant-filter";
import { aggregateBinTotals, computeOverCapWarnings } from "@/lib/plan-helpers";
import { FacilityId, ItemId, RecipeId } from "@/types/constants";
import type { ProductionGraphNode } from "@/types";

const ALL_RAWS: ReadonlySet<ItemId> = new Set(rawMaterialSources.keys());

// Models the App-side `structureVariantExcluded` filter (src/App.tsx)
// with the full Wuling Purification Node enabled — 3 Sewage Inlets
// (`availableInstances`) plus the Byproduct Outlet (`toggledFacilities`).
// It resolves the real `computeVariantExclusions` rule and drops the
// excluded recipes before the calculator runs, exactly as App.tsx does.
//
// Post issue #90 the toggle is ADDITIVE, so this keeps BOTH inlet
// variants (DISPOSAL + BYPRODUCT). Routing through the real helper (not a
// hand-written `r.id !== DISPOSAL` filter) makes these tests fail if the
// additive rule ever regresses back to dropping DISPOSAL.
const recipesWithByproductOutletOn = () => {
  const excluded = computeVariantExclusions({
    mode: "structure-aware",
    availableInstances: new Set([FacilityId.LIQUID_CLEAN_GATE_1]),
    toggledFacilities: new Set([FacilityId.LIQUID_CLEAN_GATE_1]),
  });
  return recipes.filter((r) => !excluded.has(r.id));
};

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

  test("issue #90: Byproduct Outlet ON keeps BOTH inlet variants available", () => {
    // Regression guard at the filter level: enabling the Byproduct Outlet
    // (toggle ON) must NOT drop the pure-sink DISPOSAL variant. Pre-fix
    // the App-side filter excluded DISPOSAL, leaving BYPRODUCT as the only
    // sewage sink; post-fix the toggle is additive and both survive.
    const ids = new Set(recipesWithByproductOutletOn().map((r) => r.id));
    expect(ids.has(RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL)).toBe(true);
    expect(ids.has(RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT)).toBe(true);
  });

  test("issue #90: Byproduct Outlet ON — excess sewage disposed at 0 W, no Water Treatment Unit", async () => {
    // Repro from the issue: Wuling Purification Node fully enabled (3
    // Sewage Inlets + Byproduct Outlet), target 6/min Hetonite Part
    // (item_copper_enr_cmpt). The Hetonite enrichment chain emits sewage
    // as a byproduct across its pool steps (≈270 sewage/min at this
    // target) and has no productive xiranite_poly consumer.
    //
    // Pre-fix, the App dropped DISPOSAL, so sewage was forced through
    // BYPRODUCT → xiranite_poly → Water Treatment Unit (50 W) purely to
    // destroy effluent nothing wanted. Post-fix the toggle is additive:
    // the LP disposes the excess sewage via the 0 W pure-sink DISPOSAL
    // variant and never produces (or cleans) any effluent.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_COPPER_ENR_CMPT, rate: 6 }],
      items,
      recipesWithByproductOutletOn(),
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 3]]),
      },
    );

    // Excess sewage routes through the pure-sink DISPOSAL variant (0 W).
    const inlet = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL);
    expect(inlet).toBeDefined();
    expect(inlet!.facilityCount).toBeGreaterThan(0);

    // DISPOSAL absorbs ALL the sewage the Hetonite chain emits, within the
    // 3-inlet cap (no spillover to a cleaner). Coupled to the plan's own
    // sewage production rather than a hard-coded count so the assertion
    // survives upstream recipe-rate drift.
    const sewage = plan.nodes.get(ItemId.ITEM_LIQUID_SEWAGE);
    expect(sewage?.type).toBe("item");
    if (sewage?.type === "item") {
      expect(inlet!.facilityCount).toBeCloseTo(
        sewage.productionRate / SEWAGE_PER_INLET_PER_MIN,
        4,
      );
    }
    expect(inlet!.facilityCount).toBeLessThanOrEqual(3 + 1e-9);

    // BYPRODUCT is NOT engaged — no xiranite_poly is demanded, so emitting
    // it would only create disposal work.
    expect(
      recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT),
    ).toBeUndefined();

    // The bug fix: no Water Treatment Unit is pulled in to destroy
    // effluent (xiranite_poly) — nor to dispose sewage (the Inlet cap of
    // 3×120 = 360/min covers the chain's ≈270/min load with room to
    // spare; DISPOSAL runs ≈2.25 inlets).
    expect(
      recipeNode(
        plan,
        RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_XIRANITE_POLY,
      ),
    ).toBeUndefined();
    expect(
      recipeNode(
        plan,
        RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
      ),
    ).toBeUndefined();
  });

  test("issue #90: Byproduct Outlet ON — BYPRODUCT serves real demand while DISPOSAL dumps the rest", async () => {
    // The additive payoff: with the outlet ON and a genuine downstream
    // xiranite_poly consumer, the LP taps the Byproduct Outlet to satisfy
    // that demand "for free" from sewage it is already disposing, and
    // routes the LEFTOVER sewage through the 0 W DISPOSAL sink — no Water
    // Treatment Unit, no dedicated xiranite chain.
    //
    // Targets: 6/min Hetonite Part (≈270 sewage/min byproduct) + 2/min
    // solid Xircon (item_xiranite_poly), which POOL_XIRANITE_POLY_1 makes
    // by consuming liquid xiranite_poly (2 liquid per solid → 4
    // liquid_poly/min demand). BYPRODUCT emits 4 xiranite_poly/min per
    // building, so the demand is met by exactly 1 BYPRODUCT building (120
    // sewage/min); the remaining sewage spills to DISPOSAL.
    const plan = await calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_COPPER_ENR_CMPT, rate: 6 },
        { itemId: ItemId.ITEM_XIRANITE_POLY, rate: 2 },
      ],
      items,
      recipesWithByproductOutletOn(),
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps: new Map([[FacilityId.LIQUID_CLEAN_GATE_1, 3]]),
      },
    );

    expect(plan.invalidCycles).toHaveLength(0);

    // BYPRODUCT engaged to exactly meet the 4 liquid_poly/min demand
    // (2 solid Xircon × 2 liquid each ÷ 4 per building = 1 building). The
    // LP routes the WHOLE liquid_xiranite_poly demand through BYPRODUCT
    // because it is 0 W and consumes sewage that is otherwise disposed for
    // free — strictly cheaper under the lex objective (rawCost → buildings
    // → power) than any dedicated producer (pool/purifier, which burn
    // liquid_xiranite raws and emit lowpoly needing its own disposal).
    // The exact count therefore holds despite those alternatives existing;
    // it would only shift if their relative costs were retuned below free.
    const byproduct = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT);
    expect(byproduct).toBeDefined();
    expect(byproduct!.facilityCount).toBeCloseTo(1, 4);

    // DISPOSAL coexists, absorbing the sewage the outlet didn't recycle.
    const disposal = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL);
    expect(disposal).toBeDefined();
    expect(disposal!.facilityCount).toBeGreaterThan(0);

    // Both inlet variants share the single 3-building facility cap.
    expect(
      byproduct!.facilityCount + disposal!.facilityCount,
    ).toBeLessThanOrEqual(3 + 1e-9);

    // No Water Treatment Unit: the outlet's effluent is fully consumed by
    // the Xircon demand, and the leftover sewage disposes at 0 W.
    expect(
      recipeNode(
        plan,
        RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_XIRANITE_POLY,
      ),
    ).toBeUndefined();
    expect(
      recipeNode(
        plan,
        RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
      ),
    ).toBeUndefined();
  });

  test("byproduct variant emits xiranite_poly at the 30:1 ratio (4/min/building)", async () => {
    // Isolates the BYPRODUCT recipe mechanic by removing DISPOSAL from the
    // recipe set. NOTE: this is NOT how the App configures an enabled
    // Byproduct Outlet post issue #90 (which keeps BOTH variants — see the
    // additive-routing tests above). Forcing BYPRODUCT-only here lets us
    // pin the 30:1 emission ratio and its downstream cleaner cascade.
    //
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

describe("Sewage Inlet — LP routes around binding caps via alternative producers", () => {
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
    // BYPRODUCT-only isolation (DISPOSAL removed) so the variant is
    // guaranteed to run and we can assert its render flags. Not the App's
    // outlet-on config post issue #90 (which keeps both variants).
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

  test("LP cap binding via facility-cap slack when no fallback disposer exists", async () => {
    // Construct a scenario where:
    //   - Cuprium component target = 5 × the no-bottleneck rate = 5 × 30 = 150/min
    //   - Sewage produced = 150/min
    //   - LIQUID_CLEAN_GATE_1 capped at 1 (= 120/min disposal capacity)
    //   - Liquid Cleaner removed from the recipe set
    //
    // With the LP's per-facility cap now SOFT (slack-based), two paths
    // are available for absorbing the 30/min sewage surplus:
    //   (a) facility-cap slack: Inlet = 1.25 buildings (= 150/120),
    //       slack = 0.25 → penalty = 0.25 × SLACK_PENALTY = 2.5e5.
    //   (b) disposal-slack: Inlet = 1 building (= 120/min), surplus = 30
    //       → penalty = 30 × SLACK_PENALTY = 3e7.
    //
    // The LP picks (a) — facility-cap slack is two orders of magnitude
    // cheaper than disposal-slack at this flow rate, because slack
    // units differ (buildings vs item-rate). Pre-fix (hard cap), the
    // LP was forced into (b) and the surplus was silently absorbed by
    // disposal-slack with no user-facing warning. Post-fix, the
    // disposal balance is exact and the over-cap signal surfaces
    // post-pack via `aggregateBinTotals` + `computeOverCapWarnings`
    // — strictly better UX.
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

    // Plan feasible (facility-cap slack absorbs the over-cap demand).
    expect(plan.invalidCycles).toHaveLength(0);

    // Inlet overshoots cap to exactly cover the sewage flow:
    // 150/min / 120/min/building = 1.25 buildings.
    const inlet = recipeNode(plan, RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL);
    expect(inlet).toBeDefined();
    expect(inlet!.facilityCount).toBeCloseTo(
      150 / SEWAGE_PER_INLET_PER_MIN,
      5,
    );

    // Liquid Cleaner is unavailable (filtered out of the recipe set).
    expect(
      plan.nodes.get(
        RecipeId.FLUID_CONSUME_LIQUID_CLEANER_1_ITEM_LIQUID_SEWAGE,
      ),
    ).toBeUndefined();
  });
});

describe("Facility cap binding without alternative producer", () => {
  // The LP's per-facility cap is SOFT (slack-based; see
  // `lp-solver.ts:LPInput.facilityCaps` JSDoc): when target demand
  // exceeds `cap × throughput` AND no alternative producer is
  // available, slack engages and the LP returns a feasible (over-cap)
  // plan. The packer's retry-without-caps + `computeOverCapWarnings`
  // pipeline surface the over-cap warning at the hook layer.
  //
  // Pre-fix (commit `849a147` through the pre-soft-cap state), the LP
  // returned `infeasible` in this class of scenarios and the user saw
  // `[FAILED] Global LP infeasible. Returning best-effort result with
  // N invalid cycle(s)` instead of a plan + warning.

  test("Heavy Xiranite reproducer (user-reported): xiranite_oven_1 cap=2 + target=6/min stays feasible and surfaces over-cap warning", async () => {
    // User-reported reproducer. Heavy Xiranite production chain:
    //   - XIRANITE_OVEN_XIRANITE_ENR_POWDER_1 (xiranite_oven_1):
    //       1 Heavy Xiranite / 10s = 6/min/building.
    //       Target = 6/min → 1 Forge.
    //   - Upstream Xiranite Powder via XIRANITE_OVEN_XIRANITE_POWDER_1
    //     (also xiranite_oven_1): 1/2s = 30/min/building.
    //       Demand = 60 Xiranite Powder/min (10 per Heavy Xiranite cycle)
    //       → 2 Forges.
    //   - Total: 3 Forges on xiranite_oven_1.
    // With cap = 2, pre-fix the hard LP cap returned infeasible.
    // Post-fix, soft slack engages and the plan is feasible; the
    // post-pack `computeOverCapWarnings` then surfaces the over-cap
    // signal to the user — that's the entire UX point of the
    // soft-cap design. This test locks both ends of the contract
    // (LP feasibility + warning surface).
    const facilityCaps = new Map([[FacilityId.XIRANITE_OVEN_1, 2]]);
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_ENR_POWDER, rate: 6 }],
      items,
      recipes,
      facilities,
      {
        rawMaterials: ALL_RAWS,
        facilityCaps,
      },
    );

    // The key assertion: LP did NOT return infeasible.
    expect(plan.invalidCycles).toHaveLength(0);

    // Both xiranite_oven recipes are in the plan.
    const enrPowder = recipeNode(
      plan,
      RecipeId.XIRANITE_OVEN_XIRANITE_ENR_POWDER_1,
    );
    const powder = recipeNode(
      plan,
      RecipeId.XIRANITE_OVEN_XIRANITE_POWDER_1,
    );
    expect(enrPowder).toBeDefined();
    expect(powder).toBeDefined();

    // Total xiranite_oven_1 building count exceeds cap (3 vs 2).
    const totalForges =
      (enrPowder?.facilityCount ?? 0) + (powder?.facilityCount ?? 0);
    expect(totalForges).toBeGreaterThan(2);

    // End-to-end contract: the post-pack `computeOverCapWarnings`
    // pipeline (which the hook layer calls in production) emits a
    // `facility-over-cap` warning for xiranite_oven_1. Running it
    // directly here exercises the same code path the user-facing
    // warning surface depends on.
    const aggregates = aggregateBinTotals(plan, [...facilities], [...items]);
    const warnings = computeOverCapWarnings(
      aggregates.rawPerFacility,
      facilityCaps,
    );
    const ovenWarning = warnings.find(
      (w) =>
        w.kind === "facility-over-cap" &&
        w.facilityId === FacilityId.XIRANITE_OVEN_1,
    );
    expect(ovenWarning).toBeDefined();
    if (ovenWarning?.kind === "facility-over-cap") {
      expect(ovenWarning.cap).toBe(2);
      expect(ovenWarning.used).toBeGreaterThan(2);
    }
  });
});
