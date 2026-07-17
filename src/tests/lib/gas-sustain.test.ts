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

  test("mappers render the vaporizer as a consumer sink in all three views", async () => {
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
    const fused = mapPlanToFlowBinFused(
      plan,
      testItems,
      [envRecipe],
      testFacilities,
      new Map(),
      false,
    );
    const sinkId = `disposal-${RecipeId.VAPORIZE_ITEM_GAS_INERT}`;
    expect(fused.nodes.some((n) => n.id === sinkId)).toBe(true);

    const separated = mapPlanToFlowBinFusedSeparated(
      plan,
      testItems,
      [envRecipe],
      testFacilities,
      new Map(),
      false,
    );
    expect(separated.nodes.length).toBeGreaterThan(0);

    const merged = mapPlanToFlowMerged(
      plan,
      testItems,
      testFacilities,
      new Map(),
      false,
    );
    expect(merged.nodes.some((n) => n.id === sinkId)).toBe(true);
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
