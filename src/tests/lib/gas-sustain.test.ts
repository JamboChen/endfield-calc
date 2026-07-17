/**
 * 1.4 gas sustain — the `gasSustain` machinery end to end: transmuter
 * catalyst folding + whole-building idle-drain scaling, vaporizer
 * env-recipe injection + whole-building min-runs, the coverage-ratio
 * option, availability guards, and mapper rendering.
 *
 * Synthetic fixtures follow the repo convention (inline items/recipes
 * passed to `calculateProductionPlan`) with hand-computable numbers:
 *
 *   - transmuter: ore → nugget, 1/min per facility, drains 6 catalyst
 *     per minute per WHOLE building (even idle — the k = ceil(N)/N
 *     scale is the mechanism under test)
 *   - grinder: ore → catalyst, 6/min per facility
 *   - oven: ore → powder, 1/min per facility, gasEnv 1 (needs an inert
 *     Gaseous Environment)
 *   - vaporizer: burns 6 inert gas / min, always-on, one per
 *     `machinesPerVaporizer` env machines
 */
import { describe, test, expect } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { aggregateBinTotals } from "@/lib/plan-helpers";
import { calcRate } from "@/lib/utils";
import {
  mapPlanToFlowBinFused,
  mapPlanToFlowBinFusedSeparated,
} from "@/components/mappers/bin-fused-mapper";
import { mapPlanToFlowMerged } from "@/components/mappers/merged-mapper";
import type {
  Facility,
  Item,
  ProductionDependencyGraph,
  Recipe,
} from "@/types";
import { FacilityId, ItemId, RecipeId } from "@/types/constants";
import type { SustainDrain } from "@/data/gas-sustain";
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
  { id: ItemId.ITEM_IRON_POWDER, tier: 2 },
  { id: ItemId.ITEM_LIQUID_XIRANITE, tier: 2, isLiquid: true },
  { id: ItemId.ITEM_GAS_INERT, tier: 1, isGas: true },
];

const baseFacility = {
  category: 0,
  buffersIn: { belt: [], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
};

const transmuter: Facility = {
  ...baseFacility,
  id: FacilityId.TRANSMUTER_1,
  powerConsumption: 50,
  tier: 4,
};
const grinder: Facility = {
  ...baseFacility,
  id: FacilityId.GRINDER_1,
  powerConsumption: 20,
  tier: 1,
};
const oven: Facility = {
  ...baseFacility,
  id: FacilityId.XIRANITE_OVEN_1,
  powerConsumption: 100,
  tier: 2,
};
const vaporizer: Facility = {
  ...baseFacility,
  id: FacilityId.VAPORIZER_1,
  powerConsumption: 0,
  tier: 4,
  footprint: { width: 3, depth: 3 },
};
const testFacilities: Facility[] = [transmuter, grinder, oven, vaporizer];

const transRecipe: Recipe = {
  id: RecipeId.LIQUID_TRANSMUTER_1_GAS_GAS_WATER_1,
  inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
  outputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
  facilityId: FacilityId.TRANSMUTER_1,
  craftingTime: 60, // 1/min per facility
};
const catalystRecipe: Recipe = {
  id: RecipeId.GRINDER_IRON_POWDER_1,
  inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
  outputs: [{ itemId: ItemId.ITEM_LIQUID_XIRANITE, amount: 6 }],
  facilityId: FacilityId.GRINDER_1,
  craftingTime: 60, // 6/min per facility
};
const envRecipe: Recipe = {
  id: RecipeId.XIRANITE_OVEN_XIRANITE_POWDER_2,
  inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
  outputs: [{ itemId: ItemId.ITEM_IRON_POWDER, amount: 1 }],
  facilityId: FacilityId.XIRANITE_OVEN_1,
  craftingTime: 60, // 1/min per facility
  gasEnv: 1,
};

const drains: ReadonlyMap<FacilityId, SustainDrain> = new Map([
  [
    FacilityId.TRANSMUTER_1,
    { itemId: ItemId.ITEM_LIQUID_XIRANITE, ratePerMinute: 6 },
  ],
]);
const envs = new Map([
  [
    1,
    {
      gasItemId: ItemId.ITEM_GAS_INERT,
      ratePerMinute: 6,
      recipe: {
        id: RecipeId.VAPORIZE_ITEM_GAS_INERT,
        inputs: [{ itemId: ItemId.ITEM_GAS_INERT, amount: 6 }],
        outputs: [],
        facilityId: FacilityId.VAPORIZER_1,
        craftingTime: 60, // 6/min per always-on vaporizer
      } satisfies Recipe,
    },
  ],
]);

const RAWS: ReadonlySet<ItemId> = new Set([
  ItemId.ITEM_IRON_ORE,
  ItemId.ITEM_GAS_INERT,
]);

const getRecipeNode = (plan: ProductionDependencyGraph, id: RecipeId) => {
  const node = plan.nodes.get(id);
  if (!node || node.type !== "recipe") {
    throw new Error(`Recipe node not found: ${id}`);
  }
  return node;
};

// ── Transmuter catalyst ──────────────────────────────────────────────────────

describe("gas sustain: transmuter catalyst", () => {
  test("fractional buildings: catalyst = rate × ceil(N), not rate × N", async () => {
    // Target 2.5 nuggets/min → transmuter N = 2.5 → 3 placed buildings
    // → catalyst = 6 × 3 = 18/min (k = 3/2.5 = 1.2 on the folded
    // input) → grinder = 18/6 = 3 facilities.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 2.5 }],
      testItems,
      [transRecipe, catalystRecipe],
      testFacilities,
      { rawMaterials: RAWS, gasSustain: { drains, vaporizerEnvs: new Map() } },
    );

    expect(plan.lpStatus).toBe("ok");
    const trans = getRecipeNode(plan, transRecipe.id);
    expect(trans.facilityCount).toBeCloseTo(2.5, 3);

    // Folded catalyst input at k = 1.2: 6 × 60/60 × 1.2 = 7.2/craft.
    const catalystInput = trans.recipe.inputs.find(
      (i) => i.itemId === ItemId.ITEM_LIQUID_XIRANITE,
    );
    expect(catalystInput).toBeDefined();
    expect(catalystInput!.amount).toBeCloseTo(7.2, 3);
    // Total drain = consumption at the folded amount = 6 × ceil(2.5).
    const drainRate =
      calcRate(catalystInput!.amount, trans.recipe.craftingTime) *
      trans.facilityCount;
    expect(drainRate).toBeCloseTo(18, 3);

    const grinderNode = getRecipeNode(plan, catalystRecipe.id);
    expect(grinderNode.facilityCount).toBeCloseTo(3, 3);
  });

  test("integer buildings: no idle top-up (k stays 1)", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 2 }],
      testItems,
      [transRecipe, catalystRecipe],
      testFacilities,
      { rawMaterials: RAWS, gasSustain: { drains, vaporizerEnvs: new Map() } },
    );

    const trans = getRecipeNode(plan, transRecipe.id);
    expect(trans.facilityCount).toBeCloseTo(2, 3);
    const catalystInput = trans.recipe.inputs.find(
      (i) => i.itemId === ItemId.ITEM_LIQUID_XIRANITE,
    );
    expect(catalystInput!.amount).toBeCloseTo(6, 3);
    const grinderNode = getRecipeNode(plan, catalystRecipe.id);
    expect(grinderNode.facilityCount).toBeCloseTo(2, 3);
  });

  test("empty drains disable folding entirely", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 2.5 }],
      testItems,
      [transRecipe, catalystRecipe],
      testFacilities,
      {
        rawMaterials: RAWS,
        gasSustain: { drains: new Map(), vaporizerEnvs: new Map() },
      },
    );
    const trans = getRecipeNode(plan, transRecipe.id);
    expect(
      trans.recipe.inputs.find(
        (i) => i.itemId === ItemId.ITEM_LIQUID_XIRANITE,
      ),
    ).toBeUndefined();
    // No catalyst demand → the grinder never runs.
    expect(plan.nodes.has(catalystRecipe.id)).toBe(false);
  });
});

// ── Vaporizer environments ───────────────────────────────────────────────────

describe("gas sustain: vaporizer environments", () => {
  test("whole vaporizers per coverage group: ceil(5 machines / 4) = 2", async () => {
    // Target 4.5 powder/min → oven N = 4.5 → 5 placed machines →
    // vaporizers = ceil(5/4) = 2, always-on → 12 inert gas/min.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 4.5 }],
      testItems,
      [envRecipe],
      testFacilities,
      {
        rawMaterials: RAWS,
        gasSustain: { drains: new Map(), vaporizerEnvs: envs },
      },
    );

    expect(plan.lpStatus).toBe("ok");
    expect(plan.warnings.map((w) => w.kind)).not.toContain(
      "gas-env-unavailable",
    );
    const vap = getRecipeNode(plan, RecipeId.VAPORIZE_ITEM_GAS_INERT);
    expect(vap.facilityCount).toBeCloseTo(2, 3);

    // Gas draw feeds the raw pickup: 2 vaporizers × 6/min.
    const gasNode = plan.nodes.get(ItemId.ITEM_GAS_INERT);
    expect(gasNode?.type).toBe("item");
    if (gasNode?.type === "item") {
      expect(gasNode.productionRate).toBeCloseTo(12, 3);
    }

    // The vaporizer facility lands in the physical aggregates.
    const agg = aggregateBinTotals(plan, testFacilities, testItems, {
      ceilMode: true,
    });
    expect(agg.physicalPerFacility.get(FacilityId.VAPORIZER_1)).toBe(2);
  });

  test("machinesPerVaporizer = 1 → one vaporizer per machine", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 4.5 }],
      testItems,
      [envRecipe],
      testFacilities,
      {
        rawMaterials: RAWS,
        gasSustain: {
          drains: new Map(),
          vaporizerEnvs: envs,
          machinesPerVaporizer: 1,
        },
      },
    );
    const vap = getRecipeNode(plan, RecipeId.VAPORIZE_ITEM_GAS_INERT);
    expect(vap.facilityCount).toBeCloseTo(5, 3);
  });

  test("unsuppliable env gas: recipe still runs, warning emitted, no vaporizer", async () => {
    // gas_inert is neither raw nor producible → the injection guard
    // skips the vaporize recipe; the env recipe itself still solves
    // (honest best-effort) and the plan carries the warning.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 2 }],
      testItems,
      [envRecipe],
      testFacilities,
      {
        rawMaterials: new Set([ItemId.ITEM_IRON_ORE]),
        gasSustain: { drains: new Map(), vaporizerEnvs: envs },
      },
    );

    expect(plan.lpStatus).toBe("ok");
    expect(plan.nodes.has(RecipeId.VAPORIZE_ITEM_GAS_INERT)).toBe(false);
    const warning = plan.warnings.find(
      (w) => w.kind === "gas-env-unavailable",
    );
    expect(warning).toBeDefined();
    if (warning?.kind === "gas-env-unavailable") {
      expect(warning.env).toBe(1);
      expect(warning.gasItemId).toBe(ItemId.ITEM_GAS_INERT);
    }
  });

  test("mappers render the vaporizer as an env sink; Facility View splits per building", async () => {
    // 4.5 powder → 5 env machines → 2 vaporizers (ratio 4).
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 4.5 }],
      testItems,
      [envRecipe],
      testFacilities,
      {
        rawMaterials: RAWS,
        gasSustain: { drains: new Map(), vaporizerEnvs: envs },
      },
    );

    // `assertFlowIntegrity` throws in test mode — reaching the
    // assertions below proves integrity in each view.

    // Recipe View: ONE aggregate env sink, typed `envSink`, carrying the
    // buffed machines keyed on FORMULA (the oven's env recipe), NOT a
    // bare facility.
    const fused = mapPlanToFlowBinFused(
      plan,
      testItems,
      [envRecipe],
      testFacilities,
      new Map(),
      false,
    );
    const sinkId = `disposal-${RecipeId.VAPORIZE_ITEM_GAS_INERT}`;
    const envNode = fused.nodes.find((n) => n.id === sinkId);
    expect(envNode?.type).toBe("envSink");
    const envData = envNode!.data as unknown as {
      facilityCount: number;
      env: number;
      vaporizeRecipeId: string;
      covered: { facility: { id: string }; recipe: { id: string }; buildings: number }[];
    };
    expect(envData.facilityCount).toBe(2);
    expect(envData.env).toBe(1);
    expect(envData.vaporizeRecipeId).toBe(RecipeId.VAPORIZE_ITEM_GAS_INERT);
    expect(envData.covered).toHaveLength(1);
    expect(envData.covered[0].recipe.id).toBe(envRecipe.id);
    expect(envData.covered[0].facility.id).toBe(FacilityId.XIRANITE_OVEN_1);
    expect(envData.covered[0].buildings).toBe(5); // ceil(4.5)

    // Facility View: ONE node PER vaporizer building (2), each covering
    // its representative slice of the 5 buffed machines (⌈5/2⌉ = 3, then
    // 2), keyed on formula.
    const separated = mapPlanToFlowBinFusedSeparated(
      plan,
      testItems,
      [envRecipe],
      testFacilities,
      new Map(),
      false,
    );
    const envUnits = separated.nodes.filter((n) => n.type === "envSink");
    expect(envUnits).toHaveLength(2);
    for (const u of envUnits) {
      const d = u.data as unknown as {
        facilityCount: number;
        covered: { recipe: { id: string }; buildings: number }[];
      };
      expect(d.facilityCount).toBe(1);
      // Every covered entry is keyed on the env FORMULA.
      for (const c of d.covered) expect(c.recipe.id).toBe(envRecipe.id);
    }
    // Partition sums back to the full buffed set (5 machines).
    const totalCovered = envUnits.reduce(
      (sum, u) =>
        sum +
        (u.data as unknown as { covered: { buildings: number }[] }).covered.reduce(
          (s, c) => s + c.buildings,
          0,
        ),
      0,
    );
    expect(totalCovered).toBe(5);
    // Per-unit ids are distinct building instances.
    expect(new Set(envUnits.map((n) => n.id)).size).toBe(2);

    // Merged (legacy bf=0): ONE aggregate env sink.
    const merged = mapPlanToFlowMerged(
      plan,
      testItems,
      testFacilities,
      new Map(),
      false,
    );
    expect(merged.nodes.find((n) => n.id === sinkId)?.type).toBe("envSink");
  });
});

// ── Env-coverage pricing (first-solve tie rows) ──────────────────────────────

describe("gas sustain: env-coverage pricing", () => {
  test("env-gated route pays its gas share from the FIRST solve", async () => {
    // Two producers of the same product at equal ore cost:
    //   - plain oven recipe: 1/min per facility (4 buildings for 4/min)
    //   - env-gated transmuter recipe: 2/min per facility (2 buildings)
    // Without the `envCoverage` tie rows the first solve prices the env
    // route at ZERO gas (min-runs only appear after packing, and are
    // then sunk cost), so the buildings pass picks the env route — and
    // the plan pays vaporizer gas the plain route avoids. With the tie
    // rows the env route costs its fractional vaporizer share up front
    // (2 machines / 4 per unit × 6 gas = 3 gas/min > 0) and loses the
    // rawCost pass outright.
    const plainRecipe: Recipe = {
      id: RecipeId.XIRANITE_OVEN_XIRANITE_POWDER_1,
      inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
      outputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
      facilityId: FacilityId.XIRANITE_OVEN_1,
      craftingTime: 60, // 1/min per facility
    };
    const envAltRecipe: Recipe = {
      id: RecipeId.LIQUID_TRANSMUTER_1_GAS_GAS_WATER_1,
      inputs: [{ itemId: ItemId.ITEM_IRON_ORE, amount: 1 }],
      outputs: [{ itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 }],
      facilityId: FacilityId.TRANSMUTER_1,
      craftingTime: 30, // 2/min per facility — wins on buildings
      gasEnv: 1,
    };
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 4 }],
      testItems,
      [plainRecipe, envAltRecipe],
      testFacilities,
      {
        rawMaterials: RAWS,
        // No catalyst drain — isolate the env-coverage pricing.
        gasSustain: { drains: new Map(), vaporizerEnvs: envs },
      },
    );

    expect(plan.lpStatus).toBe("ok");
    const plain = getRecipeNode(plan, plainRecipe.id);
    expect(plain.facilityCount).toBeCloseTo(4, 3);
    expect(plan.nodes.has(envAltRecipe.id)).toBe(false);
    expect(plan.nodes.has(RecipeId.VAPORIZE_ITEM_GAS_INERT)).toBe(false);
  });
});

// ── Real 1.4 data ────────────────────────────────────────────────────────────

describe("gas sustain: real 1.4 data", () => {
  const WULING_RAWS = rawAvailabilityByDomain.get(DomainId.DOMAIN_2)!;

  test("gas_copper_enr2 plan: both envs vaporized, catalyst = 6 × placed transmuters", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_GAS_COPPER_ENR2, rate: 10 }],
      realItems,
      realRecipes,
      realFacilities,
      { rawMaterials: WULING_RAWS },
    );

    expect(plan.lpStatus).toBe("ok");
    expect(plan.invalidCycles).toEqual([]);

    // The Gas Reactor Globe's recipe is acid-env-gated (env 3); the
    // purifier's enr recipe used upstream is inert-gated (env 1). Both
    // vaporize recipes must run at ≥ 1 whole always-on unit.
    const vapAcid = getRecipeNode(plan, RecipeId.VAPORIZE_ITEM_GAS_ACID);
    expect(vapAcid.facilityCount).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(Math.round(vapAcid.facilityCount))).toBe(true);
    const vapInert = getRecipeNode(plan, RecipeId.VAPORIZE_ITEM_GAS_INERT);
    expect(vapInert.facilityCount).toBeGreaterThanOrEqual(1);

    // Catalyst exactness: total Liquid Xiranite drained by transmuter_1
    // recipes equals 6/min × its PLACED building count.
    const agg = aggregateBinTotals(plan, realFacilities, realItems, {
      ceilMode: true,
    });
    const placed = agg.physicalPerFacility.get(FacilityId.TRANSMUTER_1) ?? 0;
    expect(placed).toBeGreaterThan(0);
    let drained = 0;
    for (const node of plan.nodes.values()) {
      if (node.type !== "recipe") continue;
      if (node.recipe.facilityId !== FacilityId.TRANSMUTER_1) continue;
      const catalystInput = node.recipe.inputs.find(
        (i) => i.itemId === ItemId.ITEM_LIQUID_XIRANITE,
      );
      if (!catalystInput) continue;
      drained +=
        calcRate(catalystInput.amount, node.recipe.craftingTime) *
        node.facilityCount;
    }
    expect(drained).toBeCloseTo(6 * placed, 2);
  });

  test("Forge-of-the-Sky fragmentation: cap 12 plan fits 12 placements (user-reported)", async () => {
    // User-reported 1.4 regression: this exact pre-1.4 plan
    // (battery_5 9.564 + copper_enr_cmpt 3.25 + xiranite_enr_powder
    // 12.968 + bottled_rec_hp_5 5.5, power sustain on) fit a 12-Forge
    // limit; the gas-era optimum kept the FRACTIONAL oven count under
    // 12 (≈11.83) but split it 9.67 + 2.16 across two recipes — 13
    // PLACEMENTS. The loop's fragmentation-aware cap tightening must
    // shrink the LP row until the placement count fits (the LP offloads
    // the marginal production to the Solid-Gas Transmuting Unit).
    const targets = [
      { itemId: ItemId.ITEM_PROC_BATTERY_5, rate: 9.564 },
      { itemId: ItemId.ITEM_COPPER_ENR_CMPT, rate: 3.25 },
      { itemId: ItemId.ITEM_XIRANITE_ENR_POWDER, rate: 12.968 },
      { itemId: ItemId.ITEM_BOTTLED_REC_HP_5, rate: 5.5 },
    ];
    const plan = await calculateProductionPlan(
      targets,
      realItems,
      realRecipes,
      realFacilities,
      {
        rawMaterials: WULING_RAWS,
        powerSustain: { fuels: realPowerFuels },
        facilityCaps: new Map([[FacilityId.XIRANITE_OVEN_1, 12]]),
      },
    );

    expect(plan.lpStatus).toBe("ok");
    const agg = aggregateBinTotals(plan, realFacilities, realItems, {
      ceilMode: true,
    });
    expect(
      agg.physicalPerFacility.get(FacilityId.XIRANITE_OVEN_1),
    ).toBeLessThanOrEqual(12);
    expect(
      plan.warnings.find(
        (w) =>
          w.kind === "facility-over-cap" &&
          w.facilityId === FacilityId.XIRANITE_OVEN_1,
      ),
    ).toBeUndefined();
    // All four targets still met (ε-tolerant per the integer snap).
    for (const t of targets) {
      const node = plan.nodes.get(t.itemId);
      expect(node?.type).toBe("item");
      if (node?.type === "item") {
        expect(node.productionRate).toBeGreaterThanOrEqual(t.rate - 1e-3);
      }
    }
  });

  test("plans without gas recipes are untouched by the sustain machinery", async () => {
    // A pure Valley-style solid chain: no transmuters, no env recipes —
    // the sustain code paths must be inert (no vaporize nodes, no
    // catalyst items, no extra warnings).
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_CMPT, rate: 30 }],
      realItems,
      realRecipes,
      realFacilities,
      { rawMaterials: rawAvailabilityByDomain.get(DomainId.DOMAIN_1)! },
    );
    expect(plan.lpStatus).toBe("ok");
    for (const node of plan.nodes.values()) {
      if (node.type !== "recipe") continue;
      expect(node.recipe.facilityId).not.toBe(FacilityId.VAPORIZER_1);
    }
    expect(
      plan.warnings.find((w) => w.kind === "gas-env-unavailable"),
    ).toBeUndefined();
  });
});
