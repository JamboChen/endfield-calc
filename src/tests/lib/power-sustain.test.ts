/**
 * Self-sustaining power (Thermal Bank battery burning) — the
 * `powerSustain` option end to end: burn-recipe injection, the LP's
 * hard power-balance row (fixed point over circular battery→power
 * demand), target-battery preservation, fuel availability guards,
 * aggregates, and mapper rendering.
 *
 * Synthetic fixtures follow the repo convention (inline items/recipes
 * passed to `calculateProductionPlan`) with hand-computable numbers:
 *
 *   - furnace: ore → nugget, 1/min per facility, 100 W
 *   - battery maker: ore → battery, 1/min per facility, 20 W
 *   - Thermal Bank: burns 1 battery / 40 s (1.5/min per bank), 0 W,
 *     generating `powerGeneration` W per bank while fed.
 *
 * Fixed point for target nugget = 10/min with battery_1 (220 W):
 *   P = 1000 + 20·x_B,  x_B = 1.5·y,  y = P/220
 *   ⇒ P = 1000 / (1 − 30/220) = 1157.8947…
 *   ⇒ banks y ≈ 5.2632, battery rate x_B ≈ 7.8947
 */
import { describe, test, expect } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { aggregateBinTotals } from "@/lib/plan-helpers";
import { fitTargetsToLimits, isPlanFeasible } from "@/lib/target-optimizer";
import { mapPlanToFlowBinFused, mapPlanToFlowBinFusedSeparated } from "@/components/mappers/bin-fused-mapper";
import { mapPlanToFlowMerged } from "@/components/mappers/merged-mapper";
import type {
  Facility,
  Item,
  PowerFuel,
  ProductionDependencyGraph,
  Recipe,
} from "@/types";
import { FacilityId, ItemId, RecipeId } from "@/types/constants";
import {
  items as realItems,
  recipes as realRecipes,
  facilities as realFacilities,
  powerFuels as realPowerFuels,
  rawAvailabilityByDomain,
} from "@/data";
import { DomainId } from "@/types/constants";

// ── Synthetic fixtures ───────────────────────────────────────────────────────

const testItems: Item[] = [
  { id: ItemId.ITEM_IRON_ORE, tier: 1 },
  { id: ItemId.ITEM_IRON_NUGGET, tier: 2 },
  { id: ItemId.ITEM_PROC_BATTERY_1, tier: 3 },
  { id: ItemId.ITEM_PROC_BATTERY_5, tier: 4 },
];

const baseFacility = {
  category: 0,
  buffersIn: { belt: [], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
};

const furnace: Facility = {
  ...baseFacility,
  id: FacilityId.FURNANCE_1,
  powerConsumption: 100,
  tier: 1,
};
const batteryMaker: Facility = {
  ...baseFacility,
  id: FacilityId.TOOLS_ASSEBLING_MC_1,
  powerConsumption: 20,
  tier: 1,
};
const thermalBank: Facility = {
  ...baseFacility,
  id: FacilityId.POWER_STATION_1,
  powerConsumption: 0,
  tier: 2,
  footprint: { width: 2, depth: 2 },
};
const testFacilities: Facility[] = [furnace, batteryMaker, thermalBank];

const nuggetRecipe: Recipe = {
  id: RecipeId.FURNANCE_IRON_NUGGET_1,
  inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
  outputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
  facilityId: FacilityId.FURNANCE_1,
  craftingTime: 60, // 1/min per facility
};
const battery1Recipe: Recipe = {
  id: RecipeId.TOOLS_PROC_BATTERY_1_1,
  inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
  outputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_1, amount: 1 }],
  facilityId: FacilityId.TOOLS_ASSEBLING_MC_1,
  craftingTime: 60, // 1/min per facility
};
const battery5Recipe: Recipe = {
  id: RecipeId.TOOLS_PROC_BATTERY_5_1,
  inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
  outputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_5, amount: 1 }],
  facilityId: FacilityId.TOOLS_ASSEBLING_MC_1,
  craftingTime: 60,
};

const burn1: PowerFuel = {
  powerGeneration: 220,
  recipe: {
    id: RecipeId.BURN_ITEM_PROC_BATTERY_1,
    inputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_1, amount: 1 }],
    outputs: [],
    facilityId: FacilityId.POWER_STATION_1,
    craftingTime: 40, // 1.5/min per bank
  },
};
const burn5: PowerFuel = {
  powerGeneration: 3200,
  recipe: {
    id: RecipeId.BURN_ITEM_PROC_BATTERY_5,
    inputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_5, amount: 1 }],
    outputs: [],
    facilityId: FacilityId.POWER_STATION_1,
    craftingTime: 40,
  },
};

const RAWS: ReadonlySet<ItemId> = new Set([ItemId.ITEM_IRON_ORE]);

const getRecipeNode = (plan: ProductionDependencyGraph, id: RecipeId) => {
  const node = plan.nodes.get(id);
  if (!node || node.type !== "recipe") {
    throw new Error(`Recipe node not found: ${id}`);
  }
  return node;
};

// ── Core solve behaviour ─────────────────────────────────────────────────────

describe("power sustain: LP power balance", () => {
  test("sizes banks + battery chain for the circular fixed point", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      { rawMaterials: RAWS, powerSustain: { fuels: [burn1] } },
    );

    expect(plan.lpStatus).toBe("ok");
    // Fractional fixed point: P = 1000/(1 − 30/220) = 1157.8947…, so
    // x_B = 7.8947 → the ceil-floor loop measures whole-building draw
    // 10×100 + ceil(7.895)×20 = 1160 and raises the generation floor:
    // banks = 1160/220 = 5.2727, x_B = 1.5·banks = 7.9091 (ceil stays
    // 8 → converged after one extra pass).
    const burnNode = getRecipeNode(plan, burn1.recipe.id);
    expect(burnNode.facilityCount).toBeCloseTo(5.273, 3);
    expect(burnNode.powerGeneration).toBe(220);
    expect(burnNode.isDisposal).toBe(true);

    const batteryProducer = getRecipeNode(plan, battery1Recipe.id);
    expect(batteryProducer.facilityCount).toBeCloseTo(7.909, 3);

    // Aggregates: generation is sized to the WHOLE-BUILDING draw, so
    // the fractional view shows headroom (1160 vs 1158.18) and the
    // ceil view balances exactly.
    const agg = aggregateBinTotals(plan, testFacilities, testItems, {
      ceilMode: false,
    });
    expect(agg.totalPowerGeneration).toBeCloseTo(1160, 3);
    expect(agg.totalPower).toBeCloseTo(1158.182, 3);
    // Thermal Banks appear in the facility list + occupy grid tiles
    // (2×2 × ceil(5.273) = 24), with zero power draw of their own.
    expect(agg.perFacility.get(FacilityId.POWER_STATION_1)).toBeCloseTo(
      5.273,
      3,
    );
    expect(agg.totalTiles).toBe(24);
  });

  test("without the option, no banks and no generation", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      { rawMaterials: RAWS },
    );

    expect(plan.lpStatus).toBe("ok");
    expect(plan.nodes.has(burn1.recipe.id)).toBe(false);
    expect(plan.nodes.has(ItemId.ITEM_PROC_BATTERY_1)).toBe(false);
    const agg = aggregateBinTotals(plan, testFacilities, testItems, {});
    expect(agg.totalPowerGeneration).toBe(0);
    expect(agg.totalPower).toBeCloseTo(1000, 3);
  });

  test("targeted batteries are never burned (net ≥ target)", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 10 }],
      testItems,
      [battery1Recipe],
      testFacilities,
      { rawMaterials: RAWS, powerSustain: { fuels: [burn1] } },
    );

    expect(plan.lpStatus).toBe("ok");
    // Fractional fixed point gives x_B = 11.579 → whole-building draw
    // ceil(11.579)×20 = 240 → floor: banks = 240/220 = 1.0909, burn =
    // 1.6364, production = 11.636 (ceil stays 12 → converged).
    const burnNode = getRecipeNode(plan, burn1.recipe.id);
    expect(burnNode.facilityCount).toBeCloseTo(1.091, 3);

    const batteryItem = plan.nodes.get(ItemId.ITEM_PROC_BATTERY_1);
    if (!batteryItem || batteryItem.type !== "item") {
      throw new Error("battery item node missing");
    }
    expect(batteryItem.productionRate).toBeCloseTo(11.636, 3);
    // Net available after burning = exactly the user's target.
    const burned = 1.5 * burnNode.facilityCount;
    expect(batteryItem.productionRate - burned).toBeCloseTo(10, 3);
  });

  test("auto fuel choice minimizes raw cost (prefers denser battery)", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe, battery1Recipe, battery5Recipe],
      testFacilities,
      { rawMaterials: RAWS, powerSustain: { fuels: [burn1, burn5] } },
    );

    expect(plan.lpStatus).toBe("ok");
    // Both batteries cost 1 ore each, but battery_5 yields 3200 W per
    // bank vs 220 — fewer batteries per watt, so the rawCost pass picks
    // it exclusively.
    expect(plan.nodes.has(burn5.recipe.id)).toBe(true);
    expect(plan.nodes.has(burn1.recipe.id)).toBe(false);
    // Whole-building floor: 10×100 + ceil(x_B)×20 = 1020 → banks =
    // 1020/3200 = 0.31875.
    const burnNode = getRecipeNode(plan, burn5.recipe.id);
    expect(burnNode.facilityCount).toBeCloseTo(0.319, 3);
  });

  test("power-negative fuel chain: best-effort plan + shortfall warning", async () => {
    // Battery production draws 300 W per battery/min, but burning a
    // battery yields only 220/1.5 ≈ 146.7 W per battery/min — the plan
    // can never power itself, at any scale. The power rows are SOFT
    // (one tier below the user caps), so instead of an empty
    // infeasible shell the user gets the real plan + an explicit
    // shortfall warning (10 furnaces × 100 W = 1000 W uncovered).
    const heavyMaker: Facility = { ...batteryMaker, powerConsumption: 300 };
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe, battery1Recipe],
      [furnace, heavyMaker, thermalBank],
      { rawMaterials: RAWS, powerSustain: { fuels: [burn1] } },
    );

    expect(plan.lpStatus).toBe("ok");
    const warning = plan.warnings.find(
      (w) => w.kind === "power-sustain-insufficient",
    );
    expect(warning).toBeDefined();
    if (warning?.kind === "power-sustain-insufficient") {
      expect(warning.shortfallWatts).toBeCloseTo(1000, 3);
    }
    // No batteries produced — burning them is net power-negative.
    expect(plan.nodes.has(burn1.recipe.id)).toBe(false);
    const agg = aggregateBinTotals(
      plan,
      [furnace, heavyMaker, thermalBank],
      testItems,
      {},
    );
    expect(agg.totalPowerGeneration).toBe(0);
  });
});

// ── Fuel availability guards ─────────────────────────────────────────────────

describe("power sustain: fuel availability", () => {
  test("no producible fuel → warning, no balance row, no free raws", async () => {
    // battery_1 has NO producer in this recipe set and is not raw —
    // the guard must skip it (never promote it to a free raw).
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe],
      testFacilities,
      { rawMaterials: RAWS, powerSustain: { fuels: [burn1] } },
    );

    expect(plan.lpStatus).toBe("ok");
    expect(
      plan.warnings.some((w) => w.kind === "power-sustain-unavailable"),
    ).toBe(true);
    expect(plan.nodes.has(burn1.recipe.id)).toBe(false);
    expect(plan.nodes.has(ItemId.ITEM_PROC_BATTERY_1)).toBe(false);
    const agg = aggregateBinTotals(plan, testFacilities, testItems, {});
    expect(agg.totalPowerGeneration).toBe(0);
  });

  test("unavailable fuel skipped, available fuel burns — no warning", async () => {
    // battery_5 unproducible (skipped); battery_1 available.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      { rawMaterials: RAWS, powerSustain: { fuels: [burn1, burn5] } },
    );

    expect(plan.lpStatus).toBe("ok");
    expect(
      plan.warnings.some((w) => w.kind === "power-sustain-unavailable"),
    ).toBe(false);
    expect(plan.nodes.has(burn5.recipe.id)).toBe(false);
    expect(plan.nodes.has(ItemId.ITEM_PROC_BATTERY_5)).toBe(false);
    expect(getRecipeNode(plan, burn1.recipe.id).facilityCount).toBeCloseTo(
      5.273,
      3,
    );
  });
});

// ── Ceil-floor loop (whole-building generation sizing) ───────────────────────

describe("power sustain: ceil-floor loop", () => {
  test("generation covers the whole-building (ceiled) consumption", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      { rawMaterials: RAWS, powerSustain: { fuels: [burn1] } },
    );

    const agg = aggregateBinTotals(plan, testFacilities, testItems, {
      ceilMode: true,
    });
    // Ceiled buildings each pay full power: 10×100 + ceil(7.909)×20 =
    // 1160 — and the ceil-floor loop sized generation to exactly that.
    expect(agg.totalPower).toBeCloseTo(1160, 3);
    expect(agg.totalPowerGeneration).toBeCloseTo(1160, 3);
    expect(agg.totalPowerGeneration).toBeGreaterThanOrEqual(
      agg.totalPower - 0.25,
    );
  });

  test("covers consumption the LP cannot see (raw-only target's pump)", async () => {
    // Water is a raw target — no recipe consumes it, so the LP's
    // power-balance row sees ZERO consumption. The pickup pump's 10 W
    // only appears in the packed plan's aggregates; the ceil-floor
    // loop must still spin up a bank for it. Two iterations:
    //   1. floor 10 (pump) → battery maker appears → ceil +20 W
    //   2. floor 30 → banks 30/220 = 0.1364 → converged.
    const pump: Facility = {
      ...baseFacility,
      id: FacilityId.PUMP_1,
      powerConsumption: 10,
      tier: 1,
    };
    const waterItems: Item[] = [
      ...testItems,
      { id: ItemId.ITEM_LIQUID_WATER, tier: 1, isLiquid: true },
    ];
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_LIQUID_WATER, rate: 60 }],
      waterItems,
      [battery1Recipe],
      [...testFacilities, pump],
      {
        rawMaterials: new Set([ItemId.ITEM_IRON_ORE, ItemId.ITEM_LIQUID_WATER]),
        powerSustain: { fuels: [burn1] },
      },
    );

    expect(plan.lpStatus).toBe("ok");
    const burnNode = getRecipeNode(plan, burn1.recipe.id);
    expect(burnNode.facilityCount).toBeCloseTo(30 / 220, 3);

    const agg = aggregateBinTotals(
      plan,
      [...testFacilities, pump],
      waterItems,
      { ceilMode: true },
    );
    expect(agg.totalPower).toBeCloseTo(30, 3);
    expect(agg.totalPowerGeneration).toBeCloseTo(30, 3);
  });
});

// ── Cap headroom (power yields to user limits) ───────────────────────────────

describe("power sustain: battery production never violates user caps", () => {
  // Fixture economics: nugget target 10/min uses 10 ore/min (1 ore per
  // nugget); each battery costs 1 more ore/min. Battery production is
  // a SUGGESTION — it may only spend headroom UNDER the ore cap.

  test("zero headroom → zero batteries, full shortfall warning, cap intact", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      {
        rawMaterials: RAWS,
        rawCaps: new Map([[ItemId.ITEM_IRON_ORE, 10]]),
        powerSustain: { fuels: [burn1] },
      },
    );

    expect(plan.lpStatus).toBe("ok");
    // Ore stays AT the cap — the toggle added nothing.
    const oreNode = plan.nodes.get(ItemId.ITEM_IRON_ORE);
    if (!oreNode || oreNode.type !== "item") throw new Error("ore node missing");
    expect(oreNode.productionRate).toBeCloseTo(10, 3);
    // No batteries, no generation; the full 1000 W surfaces as the
    // insufficient warning (10 furnaces × 100 W).
    expect(plan.nodes.has(burn1.recipe.id)).toBe(false);
    const warning = plan.warnings.find(
      (w) => w.kind === "power-sustain-insufficient",
    );
    expect(warning).toBeDefined();
    if (warning?.kind === "power-sustain-insufficient") {
      expect(warning.shortfallWatts).toBeCloseTo(1000, 3);
    }
    const agg = aggregateBinTotals(plan, testFacilities, testItems, {});
    expect(agg.totalPowerGeneration).toBe(0);
  });

  test("partial headroom → funds what fits, reports the remainder", async () => {
    // Cap 14 = 10 (nuggets) + 4 headroom → exactly 4 batteries/min:
    // banks = 4/1.5 = 2.667, generation = 586.67 W. Whole-building
    // consumption = 10×100 + ceil(4)×20 = 1080 W → shortfall 493.33 W.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      {
        rawMaterials: RAWS,
        rawCaps: new Map([[ItemId.ITEM_IRON_ORE, 14]]),
        powerSustain: { fuels: [burn1] },
      },
    );

    expect(plan.lpStatus).toBe("ok");
    const oreNode = plan.nodes.get(ItemId.ITEM_IRON_ORE);
    if (!oreNode || oreNode.type !== "item") throw new Error("ore node missing");
    expect(oreNode.productionRate).toBeCloseTo(14, 3);

    const batteryProducer = getRecipeNode(plan, battery1Recipe.id);
    expect(batteryProducer.facilityCount).toBeCloseTo(4, 3);
    const burnNode = getRecipeNode(plan, burn1.recipe.id);
    expect(burnNode.facilityCount).toBeCloseTo(4 / 1.5, 3);

    const agg = aggregateBinTotals(plan, testFacilities, testItems, {
      ceilMode: true,
    });
    expect(agg.totalPowerGeneration).toBeCloseTo(586.667, 2);
    expect(agg.totalPower).toBeCloseTo(1080, 3);

    const warning = plan.warnings.find(
      (w) => w.kind === "power-sustain-insufficient",
    );
    expect(warning).toBeDefined();
    if (warning?.kind === "power-sustain-insufficient") {
      expect(warning.shortfallWatts).toBeCloseTo(493.333, 2);
    }
  });

  test("Fit shrinks an unlocked target until the power shortfall clears", async () => {
    // The unlock → adjust flow (user-reported): a locked target plus an
    // unlocked one saturate the ore cap, leaving no headroom for power
    // batteries. Fit must scale the UNLOCKED target down until the
    // batteries fit — and the fitted vector must re-solve clean.
    //
    // Closed form: cap 20 ore/min; locked nugget 10 (10 ore, 1000 W);
    // unlocked nugget-2… simplest: second unlocked battery-consuming
    // demand is the battery target itself. Use nugget locked 10 +
    // battery_1 target unlocked 10 (net-for-pickup). At λ=1: ore =
    // 10 + 10 = 20 (cap), zero headroom for BURN batteries → shortfall.
    // Shrinking the battery target frees ore that funds burn batteries.
    const rawCaps = new Map([[ItemId.ITEM_IRON_ORE, 20]]);
    const solveOpts = {
      rawMaterials: RAWS,
      rawCaps,
      powerSustain: { fuels: [burn1] },
    };
    const result = await fitTargetsToLimits({
      targets: [
        { itemId: ItemId.ITEM_IRON_NUGGET, rate: 10, locked: true },
        { itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 10 },
      ],
      solve: (vector) =>
        calculateProductionPlan(
          vector,
          testItems,
          [nuggetRecipe, battery1Recipe],
          testFacilities,
          solveOpts,
        ),
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // The locked target is untouched; the unlocked one shrank.
    const fittedBatteryRate = result.rates.get(1)!;
    expect(fittedBatteryRate).toBeLessThan(10);
    expect(fittedBatteryRate).toBeGreaterThan(0);

    // The fitted vector re-solves with no shortfall (the engine's
    // verified-by-actual-solve invariant, asserted independently).
    const fitted = await calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 },
        { itemId: ItemId.ITEM_PROC_BATTERY_1, rate: fittedBatteryRate },
      ],
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      solveOpts,
    );
    expect(
      fitted.warnings.some((w) => w.kind === "power-sustain-insufficient"),
    ).toBe(false);
  });

  test("isPlanFeasible treats the shortfall warning as over-limit", async () => {
    const rawCaps = new Map([[ItemId.ITEM_IRON_ORE, 10]]);

    // Without power sustain the plan sits exactly at the cap — feasible.
    const noPower = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      { rawMaterials: RAWS, rawCaps },
    );
    expect(isPlanFeasible(noPower)).toBe(true);

    // With power sustain the unfunded shortfall marks it over-limit —
    // Fit scales unlocked targets, Max treats it as a ceiling.
    const withPower = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      { rawMaterials: RAWS, rawCaps, powerSustain: { fuels: [burn1] } },
    );
    expect(isPlanFeasible(withPower)).toBe(false);
  });
});

// ── Mapper rendering ─────────────────────────────────────────────────────────

describe("power sustain: mappers render power sinks", () => {
  const targetRates = new Map([[ItemId.ITEM_IRON_NUGGET, 10]]);

  const solve = () =>
    calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      { rawMaterials: RAWS, powerSustain: { fuels: [burn1] } },
    );

  test("bin-fused mapper emits a powerSink (recipe roster WITHOUT burn recipes)", async () => {
    const plan = await solve();
    // Deliberately pass the roster the App would pass — burn recipes
    // are NOT in availableRecipes; the mapper must resolve them from
    // the plan's own recipe nodes. assertFlowIntegrity throws in test
    // mode, so isolated nodes / dangling edges fail here hard.
    const { nodes } = mapPlanToFlowBinFused(
      plan,
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      targetRates,
      false,
    );
    const powerNodes = nodes.filter((n) => n.type === "powerSink");
    expect(powerNodes).toHaveLength(1);
    expect(powerNodes[0].data.powerGeneration).toBe(220);
    expect(powerNodes[0].data.facilityCount).toBeCloseTo(5.273, 3);
    // No mislabeled disposal card for the bank.
    expect(nodes.filter((n) => n.type === "disposalSink")).toHaveLength(0);
  });

  test("bin-fused separated mapper emits a powerSink", async () => {
    const plan = await solve();
    const { nodes } = mapPlanToFlowBinFusedSeparated(
      plan,
      testItems,
      [nuggetRecipe, battery1Recipe],
      testFacilities,
      targetRates,
      false,
    );
    expect(nodes.filter((n) => n.type === "powerSink")).toHaveLength(1);
  });

  test("merged mapper emits a powerSink", async () => {
    const plan = await solve();
    const { nodes } = mapPlanToFlowMerged(
      plan,
      testItems,
      testFacilities,
      targetRates,
      false,
    );
    const powerNodes = nodes.filter((n) => n.type === "powerSink");
    expect(powerNodes).toHaveLength(1);
    expect(powerNodes[0].data.powerGeneration).toBe(220);
    expect(nodes.filter((n) => n.type === "disposalSink")).toHaveLength(0);
  });
});

// ── Real game data ───────────────────────────────────────────────────────────

describe("power sustain: real game data", () => {
  test("Valley IV iron components plan powers itself with real fuels", async () => {
    const rawMaterials = rawAvailabilityByDomain.get(DomainId.DOMAIN_1)!;
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_CMPT, rate: 30 }],
      realItems,
      realRecipes,
      realFacilities,
      { rawMaterials, powerSustain: { fuels: realPowerFuels } },
    );

    expect(plan.lpStatus).toBe("ok");
    expect(
      plan.warnings.some((w) => w.kind === "power-sustain-unavailable"),
    ).toBe(false);

    // At least one Thermal Bank burn recipe runs.
    const burnNodes = realPowerFuels
      .map((f) => plan.nodes.get(f.recipe.id))
      .filter((n) => n !== undefined && n.type === "recipe");
    expect(burnNodes.length).toBeGreaterThan(0);

    // Generation covers the WHOLE-BUILDING consumption (ceil-floor
    // loop), which subsumes the fractional figure.
    const ceilAgg = aggregateBinTotals(plan, realFacilities, realItems, {
      ceilMode: true,
    });
    expect(ceilAgg.totalPowerGeneration).toBeGreaterThan(0);
    expect(ceilAgg.totalPowerGeneration).toBeGreaterThanOrEqual(
      ceilAgg.totalPower - 0.25,
    );
    // Thermal Banks show up in the facility list.
    expect(
      ceilAgg.perFacility.get(FacilityId.POWER_STATION_1),
    ).toBeGreaterThan(0);
  });

  test("regression: maxed-out ore cap — power never adds cap overage (issue: 590→700 ore)", async () => {
    // The user-reported plan: locked targets already need ~590 ore/min
    // against the 540 default cap. Toggling power sustain used to push
    // ore to ~700 (hard power rows outranked the soft caps); now the
    // battery suggestion is funded only from headroom — of which there
    // is none — so ore stays EXACTLY where the target-only plan put it
    // and the shortfall surfaces as an explicit warning.
    const { defaultRawCapsByDomain } = await import("@/data");
    const rawMaterials = rawAvailabilityByDomain.get(DomainId.DOMAIN_2)!;
    const rawCaps = defaultRawCapsByDomain.get(DomainId.DOMAIN_2)!;
    const targets = [
      { itemId: ItemId.ITEM_PROC_BATTERY_5, rate: 14.75 },
      { itemId: ItemId.ITEM_COPPER_ENR_CMPT, rate: 3.25 },
      { itemId: ItemId.ITEM_XIRANITE_ENR_POWDER, rate: 13.15 },
      { itemId: ItemId.ITEM_BOTTLED_REC_HP_5, rate: 5.5 },
    ];
    const oreUsage = (plan: ProductionDependencyGraph): number => {
      const n = plan.nodes.get(ItemId.ITEM_ORIGINIUM_ORE);
      return n && n.type === "item" ? n.productionRate : 0;
    };

    const noPower = await calculateProductionPlan(
      targets,
      realItems,
      realRecipes,
      realFacilities,
      { rawMaterials, rawCaps },
    );
    const withPower = await calculateProductionPlan(
      targets,
      realItems,
      realRecipes,
      realFacilities,
      { rawMaterials, rawCaps, powerSustain: { fuels: realPowerFuels } },
    );

    expect(withPower.lpStatus).toBe("ok");
    // Power adds ZERO ore overage on top of the target-driven usage.
    expect(oreUsage(withPower)).toBeCloseTo(oreUsage(noPower), 1);
    // The uncovered watts surface as the insufficient warning.
    expect(
      withPower.warnings.some((w) => w.kind === "power-sustain-insufficient"),
    ).toBe(true);
  });

  test("regression: power toggle never flips the Metastorage route into cap overage (issue: powder→battery_3, ore 540→590)", async () => {
    // User session: the Valley IV route imports originium_enr_powder,
    // which is exactly what lets the locked targets fit the 540 ore
    // cap. Toggling power used to flip the route to battery_3 (a token
    // 367 W of generation, ranked by a watts-into-items/min slack sum)
    // — abandoning the powder import and pushing ore to 590. With
    // `powerShortfall` as its own comparison key BELOW `slackMagnitude`
    // the cap-compliant powder candidate must win.
    const { defaultRawCapsByDomain, metastorageSources, metastorageExports } =
      await import("@/data");
    const rawMaterials = rawAvailabilityByDomain.get(DomainId.DOMAIN_2)!;
    const rawCaps = defaultRawCapsByDomain.get(DomainId.DOMAIN_2)!;
    const src = metastorageSources.get(DomainId.DOMAIN_1)!;
    const routes = [
      {
        sourceDomain: DomainId.DOMAIN_1,
        ttvBudgetPerMinute: src.ttvCapPerCycle / (src.cycleSeconds / 60),
        cycleSeconds: src.cycleSeconds,
        itemCosts: metastorageExports.get(DomainId.DOMAIN_1)!,
      },
    ];
    const targets = [
      { itemId: ItemId.ITEM_PROC_BATTERY_5, rate: 14.75 },
      { itemId: ItemId.ITEM_COPPER_ENR_CMPT, rate: 3.25 },
      { itemId: ItemId.ITEM_XIRANITE_ENR_POWDER, rate: 13.15 },
      { itemId: ItemId.ITEM_BOTTLED_REC_HP_5, rate: 5.5 },
    ];
    const oreUsage = (plan: ProductionDependencyGraph): number => {
      const n = plan.nodes.get(ItemId.ITEM_ORIGINIUM_ORE);
      return n && n.type === "item" ? n.productionRate : 0;
    };

    const noPower = await calculateProductionPlan(
      targets,
      realItems,
      realRecipes,
      realFacilities,
      { rawMaterials, rawCaps, metastorageRoutes: routes },
    );
    // Baseline sanity: the powder import keeps ore exactly at the cap.
    expect(
      noPower.metastorageImports.map((i) => i.itemId),
    ).toContain(ItemId.ITEM_ORIGINIUM_ENR_POWDER);
    expect(oreUsage(noPower)).toBeCloseTo(540, 1);

    const withPower = await calculateProductionPlan(
      targets,
      realItems,
      realRecipes,
      realFacilities,
      {
        rawMaterials,
        rawCaps,
        metastorageRoutes: routes,
        powerSustain: { fuels: realPowerFuels },
      },
    );

    expect(withPower.lpStatus).toBe("ok");
    // The route selection must NOT flip away from the cap-conserving
    // powder import, and ore must stay at the cap.
    expect(
      withPower.metastorageImports.map((i) => i.itemId),
    ).toContain(ItemId.ITEM_ORIGINIUM_ENR_POWDER);
    expect(oreUsage(withPower)).toBeCloseTo(540, 1);
    // The unfunded watts surface as the insufficient warning.
    expect(
      withPower.warnings.some((w) => w.kind === "power-sustain-insufficient"),
    ).toBe(true);
  });

  test("regression: deep Wuling plan has no ceil-mode power deficit (issue: 513 W gap)", async () => {
    // The user-reported plan that exposed the fractional-vs-whole-
    // building gap: 28 partially-loaded bins ceiling up added ~513 W
    // the batteries were never sized for. The ceil-floor loop must
    // close it.
    const rawMaterials = rawAvailabilityByDomain.get(DomainId.DOMAIN_2)!;
    const plan = await calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_PROC_BATTERY_5, rate: 0 },
        { itemId: ItemId.ITEM_COPPER_ENR_CMPT, rate: 8.674 },
        { itemId: ItemId.ITEM_XIRANITE_ENR_POWDER, rate: 12 },
        { itemId: ItemId.ITEM_BOTTLED_REC_HP_5, rate: 0.652 },
      ],
      realItems,
      realRecipes,
      realFacilities,
      { rawMaterials, powerSustain: { fuels: realPowerFuels } },
    );

    expect(plan.lpStatus).toBe("ok");
    const ceilAgg = aggregateBinTotals(plan, realFacilities, realItems, {
      ceilMode: true,
    });
    expect(ceilAgg.totalPower).toBeGreaterThan(1000); // sanity: deep chain
    expect(ceilAgg.totalPowerGeneration).toBeGreaterThanOrEqual(
      ceilAgg.totalPower - 0.25,
    );
  });
});
