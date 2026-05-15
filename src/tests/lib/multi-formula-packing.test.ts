/**
 * Unit tests for Phase 3 packCrucibleBins.
 *
 * Style: synthetic items/recipes/facilities defined inline so each test
 * isolates one packing scenario from upstream-data drift. Uses real
 * Item/Recipe/Facility shapes with branded IDs cast at construction.
 */

import { describe, test, expect } from "vitest";
import { packCrucibleBins } from "@/lib/multi-formula-packing";
import type {
  Item,
  Recipe,
  Facility,
  ItemId,
  RecipeId,
  FacilityId,
} from "@/types";

/**
 * Thin defaults wrapper. Caller supplies the new-schema fields they care
 * about; everything else falls back to safe empty defaults. Buffers are
 * explicit in fixtures so each test exercises the same shape the solver
 * reads at runtime.
 */
const item = (id: string, opts: Partial<Item> = {}): Item => ({
  id: id as ItemId,
  tier: 1,
  ...opts,
});
const recipe = (
  id: string,
  inputs: Array<{ itemId: string; amount: number }>,
  outputs: Array<{ itemId: string; amount: number }>,
  facilityId: string,
  craftingTime = 2,
): Recipe => ({
  id: id as RecipeId,
  inputs: inputs.map((i) => ({ itemId: i.itemId as ItemId, amount: i.amount })),
  outputs: outputs.map((o) => ({ itemId: o.itemId as ItemId, amount: o.amount })),
  facilityId: facilityId as FacilityId,
  craftingTime,
});
const facility = (id: string, opts: Partial<Facility> = {}): Facility => ({
  id: id as FacilityId,
  numId: 0,
  tier: 1,
  category: 0,
  powerConsumption: 0,
  buffersIn: { belt: [], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
  cap: null,
  ...opts,
});

const buildMaps = (items: Item[], recipes: Recipe[], facilities: Facility[]) => ({
  itemMap: new Map(items.map((i) => [i.id, i])),
  recipeMap: new Map(recipes.map((r) => [r.id, r])),
  facilityMap: new Map(facilities.map((f) => [f.id, f])),
});

describe("packCrucibleBins", () => {
  describe("trivial / fallback", () => {
    test("empty demand returns empty bins", () => {
      const items: Item[] = [];
      const recipes: Recipe[] = [];
      const facilities: Facility[] = [];
      const r = packCrucibleBins({
        recipeSlotDemands: new Map(),
        ...buildMaps(items, recipes, facilities),
      });
      expect(r.bins.length).toBe(0);
      expect(r.allocations.size).toBe(0);
    });

    test("recipe on single-formula facility → singleton bin", () => {
      const items = [item("raw"), item("out")];
      const r1 = recipe("r1", [{ itemId: "raw", amount: 1 }], [{ itemId: "out", amount: 1 }], "fac");
      const fac = facility("fac", { powerConsumption: 25 }); // no cacheSlots
      const slotDemands = new Map<RecipeId, number>([
        ["r1" as RecipeId, 1.5],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, [r1], [fac]),
      });
      expect(r.bins.length).toBe(1);
      expect(r.bins[0].buildingCount).toBe(1.5);
      expect(r.bins[0].isGrouped).toBe(false);
      const alloc = r.allocations.get("r1" as RecipeId);
      expect(alloc?.totalSlots).toBeCloseTo(1.5, 6);
    });
  });

  describe("Xircon scenario (3-recipe chain)", () => {
    // Items
    const items = [
      item("xiranite_powder"),
      item("water", { isLiquid: true }),
      item("liquid_xiranite", { isLiquid: true }),
      item("liquid_xiranite_poly", { isLiquid: true }), // Xircon Effluent
      item("liquid_xiranite_lowpoly", { isLiquid: true }), // Inert XE
      item("liquid_sewage", { isLiquid: true }),
      item("iron_powder"),
      item("xiranite_poly"), // Xircon
    ];
    // Reactor (50W, 5 inner) and Expanded (100W, 8 inner) crucibles —
    // shapes mirror the production data: 2 distinct liquid-in buffers,
    // 2 distinct liquid-out buffers, 1 belt-out buffer.
    const reactor = facility("mix_pool_1", {
      powerConsumption: 50,
      cacheSlots: 5,
      buffersIn: { belt: [{ ports: 2 }], pipe: [{ ports: 1 }, { ports: 1 }] },
      buffersOut: { belt: [{ ports: 2 }], pipe: [{ ports: 1 }, { ports: 1 }] },
    });
    const expanded = facility("mix_pool_2", {
      powerConsumption: 100,
      cacheSlots: 8,
      buffersIn: { belt: [{ ports: 4 }], pipe: [{ ports: 1 }, { ports: 1 }] },
      buffersOut: { belt: [{ ports: 4 }], pipe: [{ ports: 1 }, { ports: 1 }] },
    });
    // Pool LX recipes (twins)
    const lx_1 = recipe("lx_1",
      [{ itemId: "xiranite_powder", amount: 1 }, { itemId: "water", amount: 1 }],
      [{ itemId: "liquid_xiranite", amount: 1 }],
      "mix_pool_1",
    );
    const lx_2 = recipe("lx_2",
      [{ itemId: "xiranite_powder", amount: 1 }, { itemId: "water", amount: 1 }],
      [{ itemId: "liquid_xiranite", amount: 1 }],
      "mix_pool_2",
    );
    const xe_1 = recipe("xe_1",
      [{ itemId: "liquid_xiranite", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
      [
        { itemId: "liquid_xiranite_poly", amount: 1 },
        { itemId: "liquid_xiranite_lowpoly", amount: 1 },
      ],
      "mix_pool_1",
    );
    const xe_2 = recipe("xe_2",
      [{ itemId: "liquid_xiranite", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
      [
        { itemId: "liquid_xiranite_poly", amount: 1 },
        { itemId: "liquid_xiranite_lowpoly", amount: 1 },
      ],
      "mix_pool_2",
    );
    const x_1 = recipe("x_1",
      [{ itemId: "liquid_xiranite_poly", amount: 2 }, { itemId: "iron_powder", amount: 1 }],
      [{ itemId: "xiranite_poly", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
      "mix_pool_1",
    );
    const x_2 = recipe("x_2",
      [{ itemId: "liquid_xiranite_poly", amount: 2 }, { itemId: "iron_powder", amount: 1 }],
      [{ itemId: "xiranite_poly", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
      "mix_pool_2",
    );
    const recipes = [lx_1, lx_2, xe_1, xe_2, x_1, x_2];
    const facilities = [reactor, expanded];

    test("optimal triple: 4 buildings on Expanded covering slot demand", () => {
      // Slot demands: LX = 4, XE = 4, X = 2.
      // Inner slot count for {LX,XE,X}: 8 distinct items
      // (xiranite_powder, water, liquid_xiranite, liquid_sewage,
      //  liquid_xiranite_poly, liquid_xiranite_lowpoly, iron_powder, xiranite_poly)
      // → fits Expanded (8 inner) but NOT Reactor (5 inner).
      //
      // Two MIP-optimal packings tie at 4 buildings @ 100W = 400W:
      //   - 4 × {LX,XE,X}: shape-sum 4·3 = 12, X over-provisioned by 2.
      //   - 2 × {LX,XE,X} + 2 × {LX,XE}: shape-sum 2·3+2·2 = 10, exact fit.
      // Lex pass 3 (min Σ x_t × |shape_t|) picks the second; both satisfy
      // the slot-coverage invariant which is what this test verifies.
      // Reactor singletons would cost 10 buildings @ 50W = 500W (worse).
      const slotDemands = new Map<RecipeId, number>([
        ["lx_1" as RecipeId, 4],
        ["xe_1" as RecipeId, 4],
        ["x_1" as RecipeId, 2],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, recipes, facilities),
      });

      // Total buildings should be 4.
      const totalBuildings = r.bins.reduce(
        (s, b) => s + (Number.isInteger(b.buildingCount) ? b.buildingCount : Math.ceil(b.buildingCount)),
        0,
      );
      expect(totalBuildings).toBe(4);

      // Total power = 400.
      const totalPower = r.bins.reduce(
        (s, b) => {
          const fac = facilities.find((f) => f.id === b.facilityId)!;
          return s + b.buildingCount * fac.powerConsumption;
        },
        0,
      );
      expect(totalPower).toBeCloseTo(400, 5);

      // All bins should be on Expanded.
      const allExpanded = r.bins.every(
        (b) => b.facilityId === ("mix_pool_2" as FacilityId),
      );
      expect(allExpanded).toBe(true);

      // Slot coverage invariant: every demand class allocated ≥ demand.
      const slotsByRecipe = new Map<string, number>();
      for (const bin of r.bins) {
        for (const rid of bin.recipeIds) {
          slotsByRecipe.set(
            rid,
            (slotsByRecipe.get(rid) ?? 0) + bin.buildingCount,
          );
        }
      }
      expect(slotsByRecipe.get("lx_1") ?? 0).toBeGreaterThanOrEqual(4);
      expect(slotsByRecipe.get("xe_1") ?? 0).toBeGreaterThanOrEqual(4);
      expect(slotsByRecipe.get("x_1") ?? 0).toBeGreaterThanOrEqual(2);
    });

    test("fractional demand: bin reports active rates (Xircon target=57 style)", () => {
      // Phase 2 LP demands at target=57 Xircon (real ratios).
      // x_X = 1.9, x_XE = x_LX = 3.04.
      // With lex pass 3, MIP picks 2×{LX,XE,X} + 2×{LX,XE}: 4 buildings,
      // no idle slots. The Xircon bin (`{LX,XE,X}` × 2) hosts LX/XE at
      // full 2 slots each, X at 1.9 of 2 slots (partial load).
      const slotDemands = new Map<RecipeId, number>([
        ["lx_1" as RecipeId, 3.04],
        ["xe_1" as RecipeId, 3.04],
        ["x_1" as RecipeId, 1.9],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, recipes, facilities),
      });

      // Total buildings = 4 (2 + 2).
      const totalBuildings = r.bins.reduce(
        (s, b) => s + b.buildingCount,
        0,
      );
      expect(totalBuildings).toBe(4);

      // The Xircon-producing bin contains all three recipes.
      const xirconBin = r.bins.find((b) =>
        b.externalOutputs.some((o) => o.itemId === ("xiranite_poly" as ItemId)),
      );
      expect(xirconBin).toBeDefined();
      expect(xirconBin!.recipeIds.length).toBe(3);
      expect(xirconBin!.buildingCount).toBe(2);

      // Active Xircon rate = 1.9 × 30 = 57/min (matches Phase 2 demand).
      const xirconOut = xirconBin!.externalOutputs.find(
        (o) => o.itemId === ("xiranite_poly" as ItemId),
      );
      expect(xirconOut?.rate).toBeCloseTo(57, 3);

      // Sewage: X (active 1.9) produces 57, XE (active 2) consumes 60 →
      // net -3 → EXTERNAL INPUT. (At full capacity it'd be internal;
      // at active rates X under-produces.)
      const sewageIn = xirconBin!.externalInputs.find(
        (i) => i.itemId === ("liquid_sewage" as ItemId),
      );
      expect(sewageIn?.rate).toBeCloseTo(3, 3);

      // Xiranite still internal (LX active 2 = XE active 2 in this bin).
      expect(xirconBin!.internalItems).toContain("liquid_xiranite" as ItemId);

      // Sister bin {LX, XE} absorbs the LX/XE residual (1.04 slots each).
      const sisterBin = r.bins.find(
        (b) =>
          b.recipeIds.includes("lx_1" as RecipeId) &&
          b.recipeIds.includes("xe_1" as RecipeId) &&
          !b.recipeIds.includes("x_1" as RecipeId),
      );
      expect(sisterBin).toBeDefined();
      expect(sisterBin!.buildingCount).toBe(2);
    });

    test("pass 3 prefers smaller shape mix when buildings/power tie", () => {
      // Demand x_X=1, x_LX=x_XE=2 admits two 2-building packings:
      //   - 2×{LX,XE,X}: 2 X, 2 LX, 2 XE. shape-sum 6. X over by 1.
      //   - 1×{LX,XE,X} + 1×{LX,XE}: 1 X, 2 LX, 2 XE. shape-sum 5. Exact.
      // Both: 2 buildings @ 100W = 200W. Pass 3 picks the smaller sum.
      const slotDemands = new Map<RecipeId, number>([
        ["lx_1" as RecipeId, 2],
        ["xe_1" as RecipeId, 2],
        ["x_1" as RecipeId, 1],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, recipes, facilities),
      });

      const totalBuildings = r.bins.reduce(
        (s, b) => s + b.buildingCount,
        0,
      );
      expect(totalBuildings).toBe(2);

      // Pass 3 should select 1×{LX,XE,X} + 1×{LX,XE} (smaller shape sum).
      const tripleBin = r.bins.find((b) => b.recipeIds.length === 3);
      const pairBin = r.bins.find(
        (b) =>
          b.recipeIds.length === 2 &&
          !b.recipeIds.includes("x_1" as RecipeId),
      );
      expect(tripleBin?.buildingCount).toBe(1);
      expect(pairBin?.buildingCount).toBe(1);
    });

    test("smaller demand: 1 building of {LX, XE, X} on Expanded", () => {
      // N_LX = 1, N_XE = 1, N_X = 1 → 1 Expanded with 1 building.
      // Reactor alternative: 3 singleton buildings @ 50W = 150W; Expanded 1 @ 100W.
      // Lex: minimise buildings (1 < 3), so Expanded wins.
      const slotDemands = new Map<RecipeId, number>([
        ["lx_1" as RecipeId, 1],
        ["xe_1" as RecipeId, 1],
        ["x_1" as RecipeId, 1],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, recipes, facilities),
      });
      const totalBuildings = r.bins.reduce((s, b) => s + b.buildingCount, 0);
      expect(totalBuildings).toBe(1);
      expect(r.bins[0].facilityId).toBe("mix_pool_2");
      expect(r.bins[0].isGrouped).toBe(true);
      expect(r.bins[0].recipeIds.length).toBe(3);
    });

    test("internal items: Liquid Xiranite is fully internal (1:1 LX→XE)", () => {
      // For 1:1:1 ratio, LX produces 0.5 LX/s, XE consumes 0.5 LX/s → net 0.
      // Sewage: X produces 0.5/s, XE consumes 0.5/s → net 0 (also internal!).
      // Wait — for {1,1,1} ratio: XE consumes 1 LX/cycle = 0.5/s, X produces 1
      // sewage/cycle = 0.5/s. XE consumes 1 sewage/cycle = 0.5/s. So both
      // sewage producer and consumer at 0.5/s → balanced internally.
      // But XE produces 0.5 XE/s while X consumes 1 XE/s → deficit, so XE is
      // an external INPUT (for this 1:1:1 ratio it's actually unbalanced).
      // The bin can still be valid; the deficit appears as external input.
      const slotDemands = new Map<RecipeId, number>([
        ["lx_1" as RecipeId, 1],
        ["xe_1" as RecipeId, 1],
        ["x_1" as RecipeId, 1],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, recipes, facilities),
      });
      const tripleBin = r.bins.find((b) => b.recipeIds.length === 3);
      expect(tripleBin).toBeDefined();

      // Liquid Xiranite is fully internal.
      const internalIds = new Set(tripleBin!.internalItems);
      expect(internalIds.has("liquid_xiranite" as ItemId)).toBe(true);
    });

    test("port caps reject group with > 2 liquid outputs", () => {
      // Synthetic: 3 recipes producing 3 distinct external liquids; would
      // need 3 liquid-out ports.
      const itemsWithExtras = [
        ...items,
        item("liquid_extra_a", { isLiquid: true }),
        item("liquid_extra_b", { isLiquid: true }),
        item("liquid_extra_c", { isLiquid: true }),
      ];
      const expandedSmall = facility("mix_pool_2", {
        powerConsumption: 100,
        cacheSlots: 8,
        buffersIn: { belt: [{ ports: 4 }], pipe: [{ ports: 1 }, { ports: 1 }] },
        buffersOut: { belt: [{ ports: 4 }], pipe: [{ ports: 1 }, { ports: 1 }] },
      });
      const a = recipe("a_1",
        [{ itemId: "water", amount: 1 }],
        [{ itemId: "liquid_extra_a", amount: 1 }],
        "mix_pool_2",
      );
      const b = recipe("b_1",
        [{ itemId: "water", amount: 1 }],
        [{ itemId: "liquid_extra_b", amount: 1 }],
        "mix_pool_2",
      );
      const c = recipe("c_1",
        [{ itemId: "water", amount: 1 }],
        [{ itemId: "liquid_extra_c", amount: 1 }],
        "mix_pool_2",
      );
      const slotDemands = new Map<RecipeId, number>([
        ["a_1" as RecipeId, 1],
        ["b_1" as RecipeId, 1],
        ["c_1" as RecipeId, 1],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(itemsWithExtras, [a, b, c], [expandedSmall]),
      });

      // No 3-recipe bin should exist: liquid-out cap forces 2-recipe + 1.
      const tripleBin = r.bins.find((b) => b.recipeIds.length === 3);
      expect(tripleBin).toBeUndefined();

      // Total buildings: at most 2 (one pair + one singleton).
      const totalBuildings = r.bins.reduce((s, b) => s + b.buildingCount, 0);
      expect(totalBuildings).toBeLessThanOrEqual(2);
    });
  });

  describe("Reactor 2-formula packing (grass example)", () => {
    // Reactor with 5 inner slots can host {grass1 + grass2} = 5 distinct items.
    const items = [
      item("plant_grass_powder_1"),
      item("plant_grass_powder_2"),
      item("water", { isLiquid: true }),
      item("liquid_plant_grass_1", { isLiquid: true }),
      item("liquid_plant_grass_2", { isLiquid: true }),
    ];
    const reactor = facility("mix_pool_1", {
      powerConsumption: 50,
      cacheSlots: 5,
      buffersIn: { belt: [{ ports: 2 }], pipe: [{ ports: 1 }, { ports: 1 }] },
      buffersOut: { belt: [{ ports: 2 }], pipe: [{ ports: 1 }, { ports: 1 }] },
    });
    const grass1 = recipe("grass1_1",
      [{ itemId: "plant_grass_powder_1", amount: 1 }, { itemId: "water", amount: 1 }],
      [{ itemId: "liquid_plant_grass_1", amount: 1 }],
      "mix_pool_1",
    );
    const grass2 = recipe("grass2_1",
      [{ itemId: "plant_grass_powder_2", amount: 1 }, { itemId: "water", amount: 1 }],
      [{ itemId: "liquid_plant_grass_2", amount: 1 }],
      "mix_pool_1",
    );

    test("Reactor packs 2 grass recipes when ratio allows", () => {
      const slotDemands = new Map<RecipeId, number>([
        ["grass1_1" as RecipeId, 1],
        ["grass2_1" as RecipeId, 1],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, [grass1, grass2], [reactor]),
      });
      // Optimal: 1 Reactor with both formulas (50W) > 2 separate Reactors (100W)
      // Lex pass 1 (buildings) prefers 1 < 2.
      expect(r.bins.length).toBe(1);
      expect(r.bins[0].buildingCount).toBe(1);
      expect(r.bins[0].recipeIds.length).toBe(2);
      expect(r.bins[0].facilityId).toBe("mix_pool_1");
    });
  });

  describe("recipe override pinning", () => {
    const items = [
      item("xiranite_powder"),
      item("water", { isLiquid: true }),
      item("liquid_xiranite", { isLiquid: true }),
    ];
    const reactor = facility("mix_pool_1", {
      powerConsumption: 50,
      cacheSlots: 5,
      buffersIn: { belt: [{ ports: 2 }], pipe: [{ ports: 1 }, { ports: 1 }] },
      buffersOut: { belt: [{ ports: 2 }], pipe: [{ ports: 1 }, { ports: 1 }] },
    });
    const expanded = facility("mix_pool_2", {
      powerConsumption: 100,
      cacheSlots: 8,
      buffersIn: { belt: [{ ports: 4 }], pipe: [{ ports: 1 }, { ports: 1 }] },
      buffersOut: { belt: [{ ports: 4 }], pipe: [{ ports: 1 }, { ports: 1 }] },
    });
    const lx_1 = recipe("lx_1",
      [{ itemId: "xiranite_powder", amount: 1 }, { itemId: "water", amount: 1 }],
      [{ itemId: "liquid_xiranite", amount: 1 }],
      "mix_pool_1",
    );
    const lx_2 = recipe("lx_2",
      [{ itemId: "xiranite_powder", amount: 1 }, { itemId: "water", amount: 1 }],
      [{ itemId: "liquid_xiranite", amount: 1 }],
      "mix_pool_2",
    );

    test("override forces specific variant", () => {
      const slotDemands = new Map<RecipeId, number>([
        ["lx_1" as RecipeId, 2],
      ]);
      const overrides = new Map<ItemId, RecipeId>([
        ["liquid_xiranite" as ItemId, "lx_2" as RecipeId],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        recipeOverrides: overrides,
        ...buildMaps(items, [lx_1, lx_2], [reactor, expanded]),
      });
      // With LX pinned to lx_2, all bins must use lx_2 (Expanded).
      const allOnExpanded = r.bins.every(
        (b) => b.facilityId === ("mix_pool_2" as FacilityId),
      );
      expect(allOnExpanded).toBe(true);
    });
  });

  describe("byte-identity defensive guard", () => {
    test("twin recipes have matching signatures", () => {
      const a = recipe("a",
        [{ itemId: "x", amount: 1 }],
        [{ itemId: "y", amount: 1 }],
        "fac1",
      );
      const b = recipe("b",
        [{ itemId: "x", amount: 1 }],
        [{ itemId: "y", amount: 1 }],
        "fac2",
      );
      // Different ID, different facility, identical I/O → same signature.
      // Internal helper not exported, but we verify behaviour through the
      // API: when a is in slotDemands and b is also a candidate, packing
      // can pick either.
      const items = [item("x"), item("y")];
      const fac1 = facility("fac1", {
        powerConsumption: 50,
        cacheSlots: 2,
        buffersOut: { belt: [{ ports: 1 }], pipe: [] },
      });
      const fac2 = facility("fac2", {
        powerConsumption: 80,
        cacheSlots: 2,
        buffersOut: { belt: [{ ports: 1 }], pipe: [] },
      });
      const slotDemands = new Map<RecipeId, number>([["a" as RecipeId, 1]]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, [a, b], [fac1, fac2]),
      });
      expect(r.bins.length).toBe(1);
      // Should pick the cheaper power (fac1) for 1-building tie.
      expect(r.bins[0].facilityId).toBe("fac1");
    });
  });

  describe("deterministic output", () => {
    test("repeated calls return identical bin ids", () => {
      const items = [
        item("a"), item("b"), item("c"),
        item("water", { isLiquid: true }),
        item("out_a", { isLiquid: true }),
        item("out_b", { isLiquid: true }),
      ];
      const fac = facility("fac", {
        powerConsumption: 50,
        cacheSlots: 5,
        buffersIn: { belt: [{ ports: 2 }], pipe: [{ ports: 1 }] },
        buffersOut: { belt: [], pipe: [{ ports: 1 }, { ports: 1 }] },
      });
      const r1 = recipe("r1",
        [{ itemId: "a", amount: 1 }, { itemId: "water", amount: 1 }],
        [{ itemId: "out_a", amount: 1 }],
        "fac",
      );
      const r2 = recipe("r2",
        [{ itemId: "b", amount: 1 }, { itemId: "water", amount: 1 }],
        [{ itemId: "out_b", amount: 1 }],
        "fac",
      );
      const slotDemands = new Map<RecipeId, number>([
        ["r1" as RecipeId, 1],
        ["r2" as RecipeId, 1],
      ]);
      const a = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, [r1, r2], [fac]),
      });
      const b = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, [r1, r2], [fac]),
      });
      expect(a.bins.map((x) => x.id)).toEqual(b.bins.map((x) => x.id));
    });
  });

  describe("singleton fallback", () => {
    test("single recipe with no peers → 1 building, no grouping", () => {
      const items = [item("raw"), item("out")];
      const fac = facility("fac", {
        powerConsumption: 50,
        cacheSlots: 5,
        buffersOut: { belt: [{ ports: 1 }], pipe: [] },
      });
      const r1 = recipe("r1",
        [{ itemId: "raw", amount: 1 }],
        [{ itemId: "out", amount: 1 }],
        "fac",
      );
      const slotDemands = new Map<RecipeId, number>([["r1" as RecipeId, 1]]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, [r1], [fac]),
      });
      expect(r.bins.length).toBe(1);
      expect(r.bins[0].buildingCount).toBe(1);
      expect(r.bins[0].isGrouped).toBe(false);
    });
  });

  describe("demand-id semantics on bins (regression)", () => {
    // When Phase 3 swaps a Phase-2 demand from `_1` (Reactor variant) into
    // a `_2` (Expanded twin) bin, `bin.recipeIds` must hold the DEMAND
    // recipe ids (e.g. `lx_1`) not the physical twins (e.g. `lx_2`). This
    // lets downstream consumers compare against `node.recipeId` (Phase 2's
    // pick) with plain equality.
    const items = [
      item("xiranite_powder"),
      item("water", { isLiquid: true }),
      item("liquid_xiranite", { isLiquid: true }),
    ];
    const reactor = facility("mix_pool_1", {
      powerConsumption: 50,
      cacheSlots: 5,
      buffersIn: { belt: [{ ports: 2 }], pipe: [{ ports: 1 }, { ports: 1 }] },
      buffersOut: { belt: [{ ports: 2 }], pipe: [{ ports: 1 }, { ports: 1 }] },
    });
    const expanded = facility("mix_pool_2", {
      powerConsumption: 100,
      cacheSlots: 8,
      buffersIn: { belt: [{ ports: 4 }], pipe: [{ ports: 1 }, { ports: 1 }] },
      buffersOut: { belt: [{ ports: 4 }], pipe: [{ ports: 1 }, { ports: 1 }] },
    });
    const lx_1 = recipe("lx_1",
      [{ itemId: "xiranite_powder", amount: 1 }, { itemId: "water", amount: 1 }],
      [{ itemId: "liquid_xiranite", amount: 1 }],
      "mix_pool_1",
    );
    const lx_2 = recipe("lx_2",
      [{ itemId: "xiranite_powder", amount: 1 }, { itemId: "water", amount: 1 }],
      [{ itemId: "liquid_xiranite", amount: 1 }],
      "mix_pool_2",
    );

    test("bin.recipeIds holds Phase-2 demand ids, not physical twins", () => {
      // With only one demand recipe and no other recipes, no grouping is
      // beneficial (singleton bin on Reactor wins). This singleton path
      // exercises the demand-id rule trivially: the bin shows `lx_1`,
      // the demand recipe id.
      const slotDemands = new Map<RecipeId, number>([
        ["lx_1" as RecipeId, 1],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, [lx_1, lx_2], [reactor, expanded]),
      });
      expect(r.bins.length).toBeGreaterThan(0);
      // Every bin's recipeIds must be a subset of the demand recipe ids.
      for (const bin of r.bins) {
        for (const rid of bin.recipeIds) {
          expect([...slotDemands.keys()]).toContain(rid);
        }
      }
    });

    test("grouped bin with twin swap reports demand recipe ids", () => {
      // 3-recipe Xircon-style scenario forces ILP onto Expanded; the
      // demand was on `_1` recipes, so bin.recipeIds must still be the
      // `_1` ids (not the physical `_2` twins the bin actually runs).
      const items3 = [
        item("xiranite_powder"),
        item("water", { isLiquid: true }),
        item("liquid_xiranite", { isLiquid: true }),
        item("liquid_xiranite_poly", { isLiquid: true }),
        item("liquid_xiranite_lowpoly", { isLiquid: true }),
        item("liquid_sewage", { isLiquid: true }),
        item("iron_powder"),
        item("xiranite_poly"),
      ];
      const xe_1 = recipe("xe_1",
        [{ itemId: "liquid_xiranite", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
        [
          { itemId: "liquid_xiranite_poly", amount: 1 },
          { itemId: "liquid_xiranite_lowpoly", amount: 1 },
        ],
        "mix_pool_1",
      );
      const xe_2 = recipe("xe_2",
        [{ itemId: "liquid_xiranite", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
        [
          { itemId: "liquid_xiranite_poly", amount: 1 },
          { itemId: "liquid_xiranite_lowpoly", amount: 1 },
        ],
        "mix_pool_2",
      );
      const x_1 = recipe("x_1",
        [{ itemId: "liquid_xiranite_poly", amount: 2 }, { itemId: "iron_powder", amount: 1 }],
        [{ itemId: "xiranite_poly", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
        "mix_pool_1",
      );
      const x_2 = recipe("x_2",
        [{ itemId: "liquid_xiranite_poly", amount: 2 }, { itemId: "iron_powder", amount: 1 }],
        [{ itemId: "xiranite_poly", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
        "mix_pool_2",
      );
      const slotDemands = new Map<RecipeId, number>([
        ["lx_1" as RecipeId, 4],
        ["xe_1" as RecipeId, 4],
        ["x_1" as RecipeId, 2],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items3, [lx_1, lx_2, xe_1, xe_2, x_1, x_2], [reactor, expanded]),
      });

      // All bins should be on Expanded (cheaper for grouped Xircon).
      expect(r.bins.every((b) => b.facilityId === ("mix_pool_2" as FacilityId)))
        .toBe(true);

      // Every bin's recipeIds must contain Phase-2 demand ids only —
      // never `lx_2`, `xe_2`, `x_2` (the physical twins).
      const physicalIds = new Set(["lx_2", "xe_2", "x_2"]);
      for (const bin of r.bins) {
        for (const rid of bin.recipeIds) {
          expect(physicalIds.has(rid as string)).toBe(false);
          expect(["lx_1", "xe_1", "x_1"]).toContain(rid as string);
        }
      }
    });

    test("sister filter via plain id-equality removes self correctly", () => {
      // After demand-id semantics, `bin.recipeIds.filter(rid => rid !== self)`
      // must correctly drop the row's own recipe id. Verifies the off-by-one
      // count fix (badge said "4 formulas" for a 3-formula bin).
      const items3 = [
        item("xiranite_powder"),
        item("water", { isLiquid: true }),
        item("liquid_xiranite", { isLiquid: true }),
        item("liquid_xiranite_poly", { isLiquid: true }),
        item("liquid_xiranite_lowpoly", { isLiquid: true }),
        item("liquid_sewage", { isLiquid: true }),
        item("iron_powder"),
        item("xiranite_poly"),
      ];
      const xe_1 = recipe("xe_1",
        [{ itemId: "liquid_xiranite", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
        [
          { itemId: "liquid_xiranite_poly", amount: 1 },
          { itemId: "liquid_xiranite_lowpoly", amount: 1 },
        ],
        "mix_pool_1",
      );
      const xe_2 = recipe("xe_2",
        [{ itemId: "liquid_xiranite", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
        [
          { itemId: "liquid_xiranite_poly", amount: 1 },
          { itemId: "liquid_xiranite_lowpoly", amount: 1 },
        ],
        "mix_pool_2",
      );
      const x_1 = recipe("x_1",
        [{ itemId: "liquid_xiranite_poly", amount: 2 }, { itemId: "iron_powder", amount: 1 }],
        [{ itemId: "xiranite_poly", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
        "mix_pool_1",
      );
      const x_2 = recipe("x_2",
        [{ itemId: "liquid_xiranite_poly", amount: 2 }, { itemId: "iron_powder", amount: 1 }],
        [{ itemId: "xiranite_poly", amount: 1 }, { itemId: "liquid_sewage", amount: 1 }],
        "mix_pool_2",
      );
      const slotDemands = new Map<RecipeId, number>([
        ["lx_1" as RecipeId, 1],
        ["xe_1" as RecipeId, 1],
        ["x_1" as RecipeId, 1],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items3, [lx_1, lx_2, xe_1, xe_2, x_1, x_2], [reactor, expanded]),
      });
      const tripleBin = r.bins.find((b) => b.recipeIds.length === 3);
      expect(tripleBin).toBeDefined();

      // Plain id-equality sister filter for each demand recipe.
      const selfIds = ["lx_1", "xe_1", "x_1"] as unknown as RecipeId[];
      for (const self of selfIds) {
        const sisters = tripleBin!.recipeIds.filter((rid) => rid !== self);
        expect(sisters).toHaveLength(2);
        expect(sisters).not.toContain(self);
      }
    });
  });

  describe("totals match plan.crucibleBins aggregate", () => {
    test("Reactor pair: building count and power match bin sum", () => {
      const items = [
        item("powder1"),
        item("powder2"),
        item("water", { isLiquid: true }),
        item("lpg1", { isLiquid: true }),
        item("lpg2", { isLiquid: true }),
      ];
      const reactor = facility("mix_pool_1", {
        powerConsumption: 50,
        cacheSlots: 5,
        buffersIn: { belt: [{ ports: 2 }], pipe: [{ ports: 1 }, { ports: 1 }] },
        buffersOut: { belt: [{ ports: 2 }], pipe: [{ ports: 1 }, { ports: 1 }] },
      });
      const grass1 = recipe("grass1_1",
        [{ itemId: "powder1", amount: 1 }, { itemId: "water", amount: 1 }],
        [{ itemId: "lpg1", amount: 1 }],
        "mix_pool_1",
      );
      const grass2 = recipe("grass2_1",
        [{ itemId: "powder2", amount: 1 }, { itemId: "water", amount: 1 }],
        [{ itemId: "lpg2", amount: 1 }],
        "mix_pool_1",
      );
      const slotDemands = new Map<RecipeId, number>([
        ["grass1_1" as RecipeId, 1],
        ["grass2_1" as RecipeId, 1],
      ]);
      const r = packCrucibleBins({
        recipeSlotDemands: slotDemands,
        ...buildMaps(items, [grass1, grass2], [reactor]),
      });

      // 1 paired bin = 1 building, 50W. Singleton baseline = 2 buildings, 100W.
      expect(r.bins.length).toBe(1);
      expect(r.bins[0].buildingCount).toBe(1);
      expect(r.bins[0].recipeIds.length).toBe(2);

      // Total computed via reduction matches expected.
      const totalBuildings = r.bins.reduce((s, b) => s + b.buildingCount, 0);
      const totalPower = r.bins.reduce((s, b) => {
        const fac = [reactor].find((f) => f.id === b.facilityId);
        return s + (fac?.powerConsumption ?? 0) * b.buildingCount;
      }, 0);
      expect(totalBuildings).toBe(1);
      expect(totalPower).toBe(50);
    });
  });
});
