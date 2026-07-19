/**
 * Metastorage Transfer test suite.
 *
 * Layers:
 *   1. `solveLP` — import variables, soft TTV budget, final `ttvCost`
 *      lex pass, hardened zero-variable early return.
 *   2. `calculateProductionPlan` (synthetic fixtures) — auto-selection
 *      enumeration, single-item-per-route invariant, route-off ≡
 *      baseline, import-only targets, over-budget + conflict warnings.
 *   3. Real `@/data` — Wuling plans fed by the Valley IV route.
 *   4. `computeRecipeReachability` — seed-items closure.
 */
import { describe, test, expect } from "vitest";
import {
  solveLP,
  type LPInput,
  type LPMetastorageImport,
} from "@/lib/lp-solver";
import { calculateProductionPlan } from "@/lib/calculator";
import { computeRecipeReachability } from "@/lib/recipe-reachability";
import {
  items,
  recipes,
  facilities,
  metastorageExports,
  metastorageSources,
  rawAvailabilityByDomain,
} from "@/data";
import type {
  Facility,
  Item,
  ProductionDependencyGraph,
  Recipe,
} from "@/types";
import type { MetastorageRouteConfig } from "@/types/metastorage";
import { DomainId, FacilityId, ItemId, RecipeId } from "@/types/constants";
import { mockItems, mockFacilities, simpleRecipes } from "./fixtures/test-data";
import { ALL_RAWS } from "./utils";

// ── shared fixtures ─────────────────────────────────────────────────────────

const FAC: Facility = {
  id: "fac_test" as FacilityId,
  powerConsumption: 10,
  tier: 1,
  category: 0,
  buffersIn: { belt: [], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
};
const facMap = new Map<FacilityId, Facility>([[FAC.id, FAC]]);

const makeRecipe = (
  id: string,
  inputs: { itemId: ItemId; amount: number }[],
  outputs: { itemId: ItemId; amount: number }[],
  craftingTime = 2,
): Recipe => ({
  id: id as RecipeId,
  inputs,
  outputs,
  craftingTime,
  facilityId: FAC.id,
});

const route = (
  itemId: ItemId,
  ttvCostPerItem: number,
  ttvBudgetPerMinute = 25,
): LPMetastorageImport => ({
  sourceDomain: DomainId.DOMAIN_1,
  itemId,
  ttvCostPerItem,
  ttvBudgetPerMinute,
});

/** Collect `Map<RecipeId, facilityCount>` from a plan's recipe nodes. */
const recipeCounts = (
  plan: ProductionDependencyGraph,
): Map<string, number> => {
  const out = new Map<string, number>();
  for (const [key, node] of plan.nodes) {
    if (node.type === "recipe") out.set(key, node.facilityCount);
  }
  return out;
};

// ── 1. solveLP layer ────────────────────────────────────────────────────────

describe("solveLP metastorage imports", () => {
  const r1 = makeRecipe(
    "r1",
    [{ itemId: "raw" as ItemId, amount: 1 }],
    [{ itemId: "out" as ItemId, amount: 1 }],
  );
  const baseInput = (
    outMin: number,
    imports: LPMetastorageImport[],
    recipesArr: Recipe[] = [r1],
  ): LPInput => ({
    recipes: recipesArr,
    itemConstraints: new Map([
      ["out" as ItemId, { type: "min", rhs: outMin }],
      ["raw" as ItemId, { type: "min", rhs: 0 }],
    ]),
    rawMaterials: new Set(["raw" as ItemId]),
    costlessRaws: new Set(),
    metastorageImports: imports,
    facilityMap: facMap,
  });

  test("import fully displaces local production within budget", async () => {
    // Importing is rawCost-free, so pass 1 routes the whole 20/min
    // demand through the route (max 25/min at cost 1).
    const result = await solveLP(baseInput(20, [route("out" as ItemId, 1)]));
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.facilityCounts.get("r1" as RecipeId)).toBeCloseTo(0, 5);
    expect(
      result.importRates.get(DomainId.DOMAIN_1)?.get("out" as ItemId),
    ).toBeCloseTo(20, 5);
    expect(result.ttvUsedPerMinute.get(DomainId.DOMAIN_1)).toBeCloseTo(20, 5);
    expect(result.ttvOveruse.size).toBe(0);
  });

  test("budget binds: import caps at 25/min, local tops up", async () => {
    const result = await solveLP(baseInput(40, [route("out" as ItemId, 1)]));
    if (!result.feasible) throw new Error("expected feasible");
    expect(
      result.importRates.get(DomainId.DOMAIN_1)?.get("out" as ItemId),
    ).toBeCloseTo(25, 5);
    // Remaining 15/min locally at 30/min/facility.
    expect(result.facilityCounts.get("r1" as RecipeId)).toBeCloseTo(0.5, 5);
    expect(result.ttvUsedPerMinute.get(DomainId.DOMAIN_1)).toBeCloseTo(25, 5);
    expect(result.ttvOveruse.size).toBe(0);
  });

  test("import-only demand above budget engages soft slack (overuse)", async () => {
    // No recipes at all — the route is the only supply, demand 40/min
    // at cost 1 vs budget 25 → 15 TTV/min overage.
    const input: LPInput = {
      recipes: [],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 40 }],
      ]),
      rawMaterials: new Set(),
      costlessRaws: new Set(),
      metastorageImports: [route("out" as ItemId, 1)],
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    expect(
      result.importRates.get(DomainId.DOMAIN_1)?.get("out" as ItemId),
    ).toBeCloseTo(40, 5);
    expect(result.ttvUsedPerMinute.get(DomainId.DOMAIN_1)).toBeCloseTo(40, 5);
    expect(result.ttvOveruse.get(DomainId.DOMAIN_1)).toBeCloseTo(15, 5);
  });

  test("ttvCost pass zeroes a useless import", async () => {
    // `side` has a balance row but no demand — the import variable is
    // free in passes 1-3; the final ttvCost pass must pin it to 0.
    const input: LPInput = {
      recipes: [r1],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 30 }],
        ["raw" as ItemId, { type: "min", rhs: 0 }],
        ["side" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["raw" as ItemId]),
      costlessRaws: new Set(),
      metastorageImports: [route("side" as ItemId, 1)],
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.importRates.size).toBe(0);
    expect(result.facilityCounts.get("r1" as RecipeId)).toBeCloseTo(1, 5);
  });

  test("penalty ordering: exact tie between raw-cap slack and TTV slack routes to the raw cap", async () => {
    // Constructed so each overflow unit costs EXACTLY the same number
    // of slack units on either side (2 raw/out locally vs 2 TTV/out
    // imported) — a degenerate tie under equal penalties, where HiGHS
    // may dump the violation into the physically-impossible budget.
    // TTV_SLACK_PENALTY must make the raw cap strictly cheaper.
    const r2 = makeRecipe(
      "r2",
      [{ itemId: "raw" as ItemId, amount: 2 }],
      [{ itemId: "out" as ItemId, amount: 1 }],
    );
    const input: LPInput = {
      recipes: [r2],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 20 }],
        ["raw" as ItemId, { type: "min", rhs: 0 }],
      ]),
      rawMaterials: new Set(["raw" as ItemId]),
      costlessRaws: new Set(),
      rawCaps: new Map([["raw" as ItemId, 10]]),
      metastorageImports: [route("out" as ItemId, 2)],
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    if (!result.feasible) throw new Error("expected feasible");
    // Import pinned at exactly the budget (25 TTV / cost 2 = 12.5/min);
    // the remaining 7.5/min runs locally, pushing raw to 15/min — the
    // 5/min overage lands ENTIRELY on the raw-cap slack.
    expect(
      result.importRates.get(DomainId.DOMAIN_1)?.get("out" as ItemId),
    ).toBeCloseTo(12.5, 5);
    expect(result.ttvUsedPerMinute.get(DomainId.DOMAIN_1)).toBeCloseTo(25, 5);
    expect(result.ttvOveruse.size).toBe(0);
    expect(result.facilityCounts.get("r2" as RecipeId)).toBeCloseTo(0.25, 5);
    expect(result.rawCapOveruse.get("raw" as ItemId)).toBeCloseTo(5, 5);
  });

  test("route on a raw item is skipped (no import variable)", async () => {
    const result = await solveLP(baseInput(30, [route("raw" as ItemId, 1)]));
    if (!result.feasible) throw new Error("expected feasible");
    expect(result.importRates.size).toBe(0);
    expect(result.facilityCounts.get("r1" as RecipeId)).toBeCloseTo(1, 5);
  });

  test("zero variables + positive non-raw demand is infeasible, not vacuous", async () => {
    const input: LPInput = {
      recipes: [],
      itemConstraints: new Map([
        ["out" as ItemId, { type: "min", rhs: 30 }],
      ]),
      rawMaterials: new Set(),
      costlessRaws: new Set(),
      facilityMap: facMap,
    };
    const result = await solveLP(input);
    expect(result.feasible).toBe(false);
  });
});

// ── 2. calculateProductionPlan (synthetic) ──────────────────────────────────

describe("calculateProductionPlan metastorage auto-selection", () => {
  const syntheticRoute = (
    itemCosts: ReadonlyMap<ItemId, number>,
  ): MetastorageRouteConfig => ({
    sourceDomain: DomainId.DOMAIN_1,
    ttvBudgetPerMinute: 25,
    cycleSeconds: 3600,
    itemCosts,
  });

  test("auto-pick selects the rawCost-optimal item and respects single-item-per-route", async () => {
    // simpleRecipes: ore →(furnace) nugget →(grinder) powder. Both the
    // nugget (cost 1, max 25/min) and the powder (cost 2, max 12.5/min)
    // are eligible. Importing nuggets leaves rawCost = 5 ore/min vs
    // 17.5 for the powder candidate → nugget wins pass 1.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 30 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
      {
        rawMaterials: ALL_RAWS,
        metastorageRoutes: [
          syntheticRoute(
            new Map([
              [ItemId.ITEM_IRON_NUGGET, 1],
              [ItemId.ITEM_IRON_POWDER, 2],
            ]),
          ),
        ],
      },
    );
    expect(plan.metastorageImports).toHaveLength(1);
    const imp = plan.metastorageImports[0];
    expect(imp.itemId).toBe(ItemId.ITEM_IRON_NUGGET);
    expect(imp.sourceDomain).toBe(DomainId.DOMAIN_1);
    expect(imp.ratePerMinute).toBeCloseTo(25, 3);
    expect(imp.ttvUsedPerMinute).toBeCloseTo(25, 3);
    expect(imp.ttvBudgetPerMinute).toBeCloseTo(25, 3);

    const counts = recipeCounts(plan);
    // Grinder still carries the full 30/min powder demand.
    expect(counts.get(RecipeId.GRINDER_IRON_POWDER_1)).toBeCloseTo(1, 3);
    // Furnace only makes the 5/min of nuggets the budget can't cover.
    expect(counts.get(RecipeId.FURNANCE_IRON_NUGGET_1)).toBeCloseTo(1 / 6, 3);

    // Item-node production stays LOCAL-only (imports tracked separately).
    const nuggetNode = plan.nodes.get(ItemId.ITEM_IRON_NUGGET);
    if (nuggetNode?.type !== "item") throw new Error("expected item node");
    expect(nuggetNode.productionRate).toBeCloseTo(5, 3);
    expect(plan.warnings).toHaveLength(0);
  });

  test("no routes ≡ empty routes array (zero drift)", async () => {
    const target = [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 30 }];
    const base = await calculateProductionPlan(
      target,
      mockItems,
      simpleRecipes,
      mockFacilities,
      { rawMaterials: ALL_RAWS },
    );
    const withEmpty = await calculateProductionPlan(
      target,
      mockItems,
      simpleRecipes,
      mockFacilities,
      { rawMaterials: ALL_RAWS, metastorageRoutes: [] },
    );
    expect(recipeCounts(withEmpty)).toEqual(recipeCounts(base));
    expect(withEmpty.metastorageImports).toHaveLength(0);
  });

  test("route with no graph-relevant items ≡ baseline (zero drift)", async () => {
    const target = [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 30 }];
    const base = await calculateProductionPlan(
      target,
      mockItems,
      simpleRecipes,
      mockFacilities,
      { rawMaterials: ALL_RAWS },
    );
    const withRoute = await calculateProductionPlan(
      target,
      mockItems,
      simpleRecipes,
      mockFacilities,
      {
        rawMaterials: ALL_RAWS,
        metastorageRoutes: [
          // Copper is nowhere in the iron-powder graph.
          syntheticRoute(new Map([[ItemId.ITEM_COPPER_NUGGET, 1]])),
        ],
      },
    );
    expect(recipeCounts(withRoute)).toEqual(recipeCounts(base));
    expect(withRoute.metastorageImports).toHaveLength(0);
    expect(withRoute.warnings).toHaveLength(0);
  });

  test("import is rejected when it would fragment a capped facility over its cap", async () => {
    // A capped single-formula facility (cap 2) runs the target recipe +
    // the `m` producer, fitting at 2 physical buildings. A cheaper import
    // (`imp`) would let the LP run a budget-limited SLIVER of an
    // alternative `m` producer on the SAME facility — a 0.25-building bin
    // that ceils to a whole 3rd building, over the cap of 2. The LP's
    // fractional cap slack can't see that (fractional total 1.0 ≤ 2), and
    // the import is strictly cheaper on rawCost — so without the
    // `facilityPlacementOveruse` selection key the auto-selector would
    // pick `imp` and silently push the plan over-cap. Enabling Metastorage
    // must only ever ADD supply options, never worsen the cap verdict.
    const it = (id: string): Item => ({ id: id as ItemId, tier: 1 });
    const testItems = [it("t_frag"), it("m_frag"), it("rawx_frag"), it("imp_frag")];
    const testRecipes = [
      makeRecipe(
        "make_t_frag",
        [{ itemId: "m_frag" as ItemId, amount: 1 }],
        [{ itemId: "t_frag" as ItemId, amount: 1 }],
      ),
      makeRecipe(
        "make_m_x_frag",
        [{ itemId: "rawx_frag" as ItemId, amount: 1 }],
        [{ itemId: "m_frag" as ItemId, amount: 1 }],
      ),
      makeRecipe(
        "make_m_imp_frag",
        [{ itemId: "imp_frag" as ItemId, amount: 1 }],
        [{ itemId: "m_frag" as ItemId, amount: 1 }],
      ),
    ];
    const opts = {
      rawMaterials: new Set<ItemId>(["rawx_frag" as ItemId]),
      facilityCaps: new Map<FacilityId, number>([[FAC.id, 2]]),
    };
    const target = [{ itemId: "t_frag" as ItemId, rate: 15 }];

    // Baseline (no route): fits at 2 placements.
    const base = await calculateProductionPlan(
      target,
      testItems,
      testRecipes,
      [FAC],
      opts,
    );
    expect(base.warnings.some((w) => w.kind === "facility-over-cap")).toBe(
      false,
    );

    // With the cheaper import available, the selector must reject it.
    const withRoute = await calculateProductionPlan(
      target,
      testItems,
      testRecipes,
      [FAC],
      {
        ...opts,
        metastorageRoutes: [
          {
            sourceDomain: DomainId.DOMAIN_1,
            ttvBudgetPerMinute: 7.5,
            cycleSeconds: 3600,
            itemCosts: new Map<ItemId, number>([["imp_frag" as ItemId, 1]]),
          },
        ],
      },
    );
    expect(
      withRoute.metastorageImports.some(
        (i) => i.itemId === ("imp_frag" as ItemId),
      ),
    ).toBe(false);
    expect(withRoute.warnings.some((w) => w.kind === "facility-over-cap")).toBe(
      false,
    );
  });

  test("import-only target within budget: feasible without raw promotion", async () => {
    // Battery has NO producer in simpleRecipes. With the route it must
    // stay a balanced item supplied by the import variable.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 1 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
      {
        rawMaterials: ALL_RAWS,
        metastorageRoutes: [
          syntheticRoute(new Map([[ItemId.ITEM_PROC_BATTERY_1, 20]])),
        ],
      },
    );
    expect(plan.metastorageImports).toHaveLength(1);
    expect(plan.metastorageImports[0].itemId).toBe(ItemId.ITEM_PROC_BATTERY_1);
    expect(plan.metastorageImports[0].ratePerMinute).toBeCloseTo(1, 3);
    expect(plan.metastorageImports[0].ttvUsedPerMinute).toBeCloseTo(20, 3);
    const node = plan.nodes.get(ItemId.ITEM_PROC_BATTERY_1);
    if (node?.type !== "item") throw new Error("expected item node");
    expect(node.isRawMaterial).toBe(false);
    expect(plan.invalidCycles).toHaveLength(0);
    expect(plan.warnings).toHaveLength(0);
  });

  test("import-only target above budget: no import applied, budget-insufficient warning", async () => {
    // The TTV budget is a game constant — a plan that exceeds it is
    // unrealizable, so the candidate is REJECTED (not emitted with a
    // warning). The plan comes out without flows and the diagnostic
    // warning explains exactly what would have been needed.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 10 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
      {
        rawMaterials: ALL_RAWS,
        metastorageRoutes: [
          syntheticRoute(new Map([[ItemId.ITEM_PROC_BATTERY_1, 20]])),
        ],
      },
    );
    expect(plan.metastorageImports).toHaveLength(0);
    expect(recipeCounts(plan).size).toBe(0);
    const warning = plan.warnings.find(
      (w) => w.kind === "metastorage-budget-insufficient",
    );
    if (warning?.kind !== "metastorage-budget-insufficient") {
      throw new Error("expected metastorage-budget-insufficient warning");
    }
    expect(warning.itemId).toBe(ItemId.ITEM_PROC_BATTERY_1);
    // 10/min × 20 TTV × 60 min = 12000 TTV needed per delivery vs 1500.
    expect(warning.neededPerCycle).toBeCloseTo(200 * 60, 1);
    expect(warning.capPerCycle).toBeCloseTo(1500, 1);
  });

  test("soft raw cap absorbs overflow; import stays pinned at the budget (penalty ordering)", async () => {
    // The user-reported scenario shape: demand needs more of an
    // intermediate than (soft raw cap + TTV budget) can jointly cover.
    // Per overflow unit the LP can either exceed the USER-imposed ore
    // cap (recoverable in-game → SLACK_PENALTY) or the GAME-constant
    // TTV budget (impossible → TTV_SLACK_PENALTY). With equal
    // penalties this was a degenerate tie and HiGHS sometimes dumped
    // the violation into the budget; the ordering must route ALL of it
    // into the raw cap.
    //
    // Numbers: powder 60/min ← 60 nuggets/min ← 60 ore/min. Ore soft-
    // capped at 6/min; nugget import (cost 1) capped at 25 TTV/min.
    // Expected: import exactly 25/min, furnace covers 35/min (ore
    // overage 29/min absorbed by the raw-cap slack), no TTV overage,
    // no metastorage warning.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 60 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
      {
        rawMaterials: ALL_RAWS,
        rawCaps: new Map([[ItemId.ITEM_IRON_ORE, 6]]),
        metastorageRoutes: [
          syntheticRoute(new Map([[ItemId.ITEM_IRON_NUGGET, 1]])),
        ],
      },
    );
    expect(plan.metastorageImports).toHaveLength(1);
    const imp = plan.metastorageImports[0];
    expect(imp.itemId).toBe(ItemId.ITEM_IRON_NUGGET);
    expect(imp.ratePerMinute).toBeCloseTo(25, 3);
    expect(imp.ttvUsedPerMinute).toBeCloseTo(25, 3);

    const counts = recipeCounts(plan);
    expect(counts.get(RecipeId.GRINDER_IRON_POWDER_1)).toBeCloseTo(2, 3);
    // Local nuggets cover the remaining 35/min — ABOVE the 6/min ore
    // cap (its slack absorbs the 29/min overage), never the budget.
    expect(counts.get(RecipeId.FURNANCE_IRON_NUGGET_1)).toBeCloseTo(35 / 30, 3);
    expect(
      plan.warnings.filter((w) => w.kind === "metastorage-budget-insufficient"),
    ).toHaveLength(0);
  });

  test("without a route the producer-less target degrades to raw (legacy)", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 1 }],
      mockItems,
      simpleRecipes,
      mockFacilities,
      { rawMaterials: ALL_RAWS },
    );
    const node = plan.nodes.get(ItemId.ITEM_PROC_BATTERY_1);
    if (node?.type !== "item") throw new Error("expected item node");
    expect(node.isRawMaterial).toBe(true);
    expect(plan.metastorageImports).toHaveLength(0);
  });

  test("two import-only targets on one route: conflict warning", async () => {
    const plan = await calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 1 },
        { itemId: ItemId.ITEM_BOTTLED_FOOD_1, rate: 1 },
      ],
      mockItems,
      simpleRecipes,
      mockFacilities,
      {
        rawMaterials: ALL_RAWS,
        metastorageRoutes: [
          syntheticRoute(
            new Map([
              [ItemId.ITEM_PROC_BATTERY_1, 20],
              [ItemId.ITEM_BOTTLED_FOOD_1, 10],
            ]),
          ),
        ],
      },
    );
    const conflict = plan.warnings.find(
      (w) => w.kind === "metastorage-route-conflict",
    );
    if (conflict?.kind !== "metastorage-route-conflict") {
      throw new Error("expected metastorage-route-conflict warning");
    }
    expect(conflict.itemIds).toEqual(
      [ItemId.ITEM_BOTTLED_FOOD_1, ItemId.ITEM_PROC_BATTERY_1].sort(),
    );
  });

  test("two import-only INTERMEDIATES on one route: conflict (closure beyond targets)", async () => {
    // The single target is locally producible, but its recipe needs
    // TWO distinct import-only intermediates (nugget + glass, neither
    // with a producer here). The necessity closure must reach past the
    // target into its unavoidable inputs and flag the route conflict —
    // the old target-only check missed this entirely.
    const batteryFromTwo: Recipe[] = [
      {
        id: "tools_battery_from_two" as RecipeId,
        inputs: [
          { itemId: ItemId.ITEM_IRON_NUGGET, amount: 1 },
          { itemId: ItemId.ITEM_QUARTZ_GLASS, amount: 1 },
        ],
        outputs: [{ itemId: ItemId.ITEM_PROC_BATTERY_1, amount: 1 }],
        facilityId: FacilityId.TOOLS_ASSEBLING_MC_1,
        craftingTime: 2,
      },
    ];
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 5 }],
      mockItems,
      batteryFromTwo,
      mockFacilities,
      {
        rawMaterials: new Set<ItemId>(),
        metastorageRoutes: [
          syntheticRoute(
            new Map([
              [ItemId.ITEM_IRON_NUGGET, 1],
              [ItemId.ITEM_QUARTZ_GLASS, 1],
            ]),
          ),
        ],
      },
    );
    const conflict = plan.warnings.find(
      (w) => w.kind === "metastorage-route-conflict",
    );
    if (conflict?.kind !== "metastorage-route-conflict") {
      throw new Error("expected metastorage-route-conflict warning");
    }
    expect(conflict.itemIds).toEqual(
      [ItemId.ITEM_IRON_NUGGET, ItemId.ITEM_QUARTZ_GLASS].sort(),
    );
  });

  test("conflict detection does not false-positive when matching is satisfiable", async () => {
    // Two import-only targets, each exported by its OWN route → the
    // bipartite matching covers both, so NO conflict warning fires
    // (the items are not competing for one route). Locks the matching
    // path against a naive count-based check that would warn on
    // "2 import-only items". (Whether the sequential greedy then
    // *selects* both is a separate, documented limitation — joint
    // multi-route necessity is unreachable in 1.x single-route data.)
    const plan = await calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 1 },
        { itemId: ItemId.ITEM_BOTTLED_FOOD_1, rate: 1 },
      ],
      mockItems,
      simpleRecipes,
      mockFacilities,
      {
        rawMaterials: ALL_RAWS,
        metastorageRoutes: [
          {
            sourceDomain: DomainId.DOMAIN_1,
            ttvBudgetPerMinute: 25,
            cycleSeconds: 3600,
            itemCosts: new Map([[ItemId.ITEM_PROC_BATTERY_1, 1]]),
          },
          {
            sourceDomain: DomainId.DOMAIN_2,
            ttvBudgetPerMinute: 25,
            cycleSeconds: 3600,
            itemCosts: new Map([[ItemId.ITEM_BOTTLED_FOOD_1, 1]]),
          },
        ],
      },
    );
    expect(
      plan.warnings.filter((w) => w.kind === "metastorage-route-conflict"),
    ).toHaveLength(0);
  });
});

// ── 3. Real game data ───────────────────────────────────────────────────────

describe("metastorage with real data (Wuling ← Valley IV)", () => {
  const wulingRaws = rawAvailabilityByDomain.get(DomainId.DOMAIN_2)!;
  const valleyInfo = metastorageSources.get(DomainId.DOMAIN_1)!;
  const realRoute: MetastorageRouteConfig = {
    sourceDomain: DomainId.DOMAIN_1,
    ttvBudgetPerMinute:
      valleyInfo.ttvCapPerCycle / (valleyInfo.cycleSeconds / 60),
    cycleSeconds: valleyInfo.cycleSeconds,
    itemCosts: metastorageExports.get(DomainId.DOMAIN_1)!,
  };

  test("generated data shape: Valley IV exports at 25 TTV/min", () => {
    expect(realRoute.ttvBudgetPerMinute).toBeCloseTo(25, 5);
    expect(valleyInfo.unlockLosslessLevel).toBe(12);
    expect(realRoute.itemCosts.size).toBeGreaterThan(50);
    // Issue-cited examples: common items cost 1, Buck Capsule (B) 20.
    expect(realRoute.itemCosts.get(ItemId.ITEM_ORIGINIUM_ENR_POWDER)).toBe(1);
    expect(realRoute.itemCosts.get(ItemId.ITEM_BOTTLED_REC_HP_2)).toBe(20);
  });

  test("quartz glass at Wuling is import-only and arrives via the route", async () => {
    // Wuling has no quartz sand; with the route the lex LP prefers
    // importing the glass itself (0 buildings) over importing sand or
    // powder and refining locally, and the ttvCost pass pins the rate
    // to exactly the 20/min demand.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_QUARTZ_GLASS, rate: 20 }],
      items,
      recipes,
      facilities,
      { rawMaterials: wulingRaws, metastorageRoutes: [realRoute] },
    );
    expect(plan.invalidCycles).toHaveLength(0);
    expect(plan.metastorageImports).toHaveLength(1);
    const imp = plan.metastorageImports[0];
    expect(imp.itemId).toBe(ItemId.ITEM_QUARTZ_GLASS);
    expect(imp.ratePerMinute).toBeCloseTo(20, 3);
    expect(imp.ttvUsedPerMinute).toBeCloseTo(20, 3);
    // Nothing produced locally.
    expect(recipeCounts(plan).size).toBe(0);
    expect(plan.warnings).toHaveLength(0);
  });

  test("HC Valley Battery 6/min: full chain local, single within-budget import, no budget warnings", async () => {
    // Regression for the user-reported scenario shape: with the FULL
    // recipe set, Steel Part (60/min) is producible locally at Wuling,
    // so the route must never engage budget overage — it just imports
    // the single lex-best item within the 25 TTV/min budget.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PROC_BATTERY_3, rate: 6 }],
      items,
      recipes,
      facilities,
      { rawMaterials: wulingRaws, metastorageRoutes: [realRoute] },
    );
    expect(plan.invalidCycles).toHaveLength(0);
    expect(plan.metastorageImports).toHaveLength(1);
    expect(plan.metastorageImports[0].ttvUsedPerMinute).toBeLessThanOrEqual(
      25 + 1e-6,
    );
    // Steel Parts run locally: 60/min ÷ 30/min per Component Assembler.
    expect(
      recipeCounts(plan).get(RecipeId.COMPONENT_IRON_ENR_CMPT_1),
    ).toBeCloseTo(2, 3);
    expect(
      plan.warnings.filter(
        (w) =>
          w.kind === "metastorage-budget-insufficient" ||
          w.kind === "metastorage-route-conflict",
      ),
    ).toHaveLength(0);
  });

  test("Dense Originium Powder: route displaces local production up to the cap", async () => {
    const target = [{ itemId: ItemId.ITEM_ORIGINIUM_ENR_POWDER, rate: 30 }];
    const base = await calculateProductionPlan(
      target,
      items,
      recipes,
      facilities,
      { rawMaterials: wulingRaws },
    );
    const withRoute = await calculateProductionPlan(
      target,
      items,
      recipes,
      facilities,
      { rawMaterials: wulingRaws, metastorageRoutes: [realRoute] },
    );

    expect(withRoute.metastorageImports).toHaveLength(1);
    const imp = withRoute.metastorageImports[0];
    expect(imp.itemId).toBe(ItemId.ITEM_ORIGINIUM_ENR_POWDER);
    expect(imp.ratePerMinute).toBeCloseTo(25, 3);
    expect(imp.ttvUsedPerMinute).toBeLessThanOrEqual(25 + 1e-6);

    const sum = (p: ProductionDependencyGraph) => {
      let total = 0;
      for (const fc of recipeCounts(p).values()) total += fc;
      return total;
    };
    expect(sum(withRoute)).toBeLessThan(sum(base));
    expect(withRoute.warnings).toHaveLength(0);
  });
});

// ── 4. Reachability seeding ─────────────────────────────────────────────────

describe("computeRecipeReachability seedItems", () => {
  const glassRecipe = makeRecipe(
    "furnace_glass",
    [{ itemId: ItemId.ITEM_QUARTZ_SAND, amount: 1 }],
    [{ itemId: ItemId.ITEM_QUARTZ_GLASS, amount: 1 }],
  );

  test("seed items unlock downstream recipes and join reachableItems", () => {
    const { reachableItems, runnableRecipes } = computeRecipeReachability(
      [glassRecipe],
      new Set(),
      new Set(),
      new Set([ItemId.ITEM_QUARTZ_SAND]),
    );
    expect(runnableRecipes).toHaveLength(1);
    expect(reachableItems.has(ItemId.ITEM_QUARTZ_SAND)).toBe(true);
    expect(reachableItems.has(ItemId.ITEM_QUARTZ_GLASS)).toBe(true);
  });

  test("without seeds the same recipe stays blocked", () => {
    const { runnableRecipes, blockedRecipes } = computeRecipeReachability(
      [glassRecipe],
      new Set(),
      new Set(),
    );
    expect(runnableRecipes).toHaveLength(0);
    expect(blockedRecipes).toHaveLength(1);
  });
});
