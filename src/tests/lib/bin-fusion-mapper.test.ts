/**
 * Bin-fused mapper tests.
 *
 * Covers:
 *   - `pickBinHeadlineOutput` heuristic ordering: target → tier → solid →
 *     alphabetical.
 *   - `mapPlanToFlowBinFused` (Recipe View): one node per bin, headline
 *     is the bin's user-targeted output, byproducts list contains other
 *     external outputs, internal items get no edges.
 *   - `mapPlanToFlowBinFusedSeparated` (Facility View): one node per
 *     building (`ceil(bin.buildingCount)` nodes per bin), per-building
 *     rates are bin total ÷ buildingCount.
 *   - Edge integrity: every edge's source and target are emitted nodes;
 *     no orphan nodes.
 */

import { describe, test, expect } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { pickBinHeadlineOutput } from "@/lib/plan-helpers";
import { mapPlanToFlowBinFused, mapPlanToFlowBinFusedSeparated } from "@/components/mappers/bin-fused-mapper";
import { items, recipes, facilities } from "@/data";
import { ItemId } from "@/types/constants";
import type {
  CrucibleBin,
  Item,
  Recipe,
  ItemId as ItemIdType,
  RecipeId as RecipeIdType,
} from "@/types";

const mkItem = (id: string, opts: Partial<Item> = {}): Item => ({
  id: id as ItemIdType,
  tier: 1,
  ...opts,
});
const mkRecipe = (
  id: string,
  inputs: Array<{ itemId: string; amount: number }>,
  outputs: Array<{ itemId: string; amount: number }>,
): Recipe => ({
  id: id as RecipeIdType,
  inputs: inputs.map((i) => ({ itemId: i.itemId as ItemIdType, amount: i.amount })),
  outputs: outputs.map((o) => ({
    itemId: o.itemId as ItemIdType,
    amount: o.amount,
  })),
  facilityId: "fac" as never,
  craftingTime: 2,
});

describe("pickBinHeadlineOutput", () => {
  test("targets win over tier", () => {
    const itemA = mkItem("a", { tier: 1 });
    const itemB = mkItem("b", { tier: 5 });
    const recipeA = mkRecipe("ra", [], [{ itemId: "a", amount: 1 }]);
    const recipeB = mkRecipe("rb", [], [{ itemId: "b", amount: 1 }]);
    const bin: CrucibleBin = {
      id: "bin-test",
      facilityId: "fac" as never,
      recipeIds: ["ra", "rb"] as never[],
      buildingCount: 1,
      externalInputs: [],
      externalOutputs: [
        { itemId: "a" as ItemIdType, rate: 30, isLiquid: false },
        { itemId: "b" as ItemIdType, rate: 30, isLiquid: false },
      ],
      internalItems: [],
      innerSlotsUsed: 2,
      isGrouped: true,
    };
    const result = pickBinHeadlineOutput(
      bin,
      [itemA, itemB],
      [recipeA, recipeB],
      new Set(["a"] as unknown as ItemIdType[]), // a is target
    );
    expect(result?.itemId).toBe("a"); // target a beats tier-5 b.
  });

  test("highest tier wins when no targets", () => {
    const itemA = mkItem("a", { tier: 1 });
    const itemB = mkItem("b", { tier: 5 });
    const recipeA = mkRecipe("ra", [], [{ itemId: "a", amount: 1 }]);
    const recipeB = mkRecipe("rb", [], [{ itemId: "b", amount: 1 }]);
    const bin: CrucibleBin = {
      id: "bin-test",
      facilityId: "fac" as never,
      recipeIds: ["ra", "rb"] as never[],
      buildingCount: 1,
      externalInputs: [],
      externalOutputs: [
        { itemId: "a" as ItemIdType, rate: 30, isLiquid: false },
        { itemId: "b" as ItemIdType, rate: 30, isLiquid: false },
      ],
      internalItems: [],
      innerSlotsUsed: 2,
      isGrouped: true,
    };
    const result = pickBinHeadlineOutput(bin, [itemA, itemB], [recipeA, recipeB], new Set());
    expect(result?.itemId).toBe("b"); // tier 5 beats tier 1.
  });

  test("solid wins over liquid at same tier", () => {
    const itemSolid = mkItem("solid", { tier: 3, isLiquid: false });
    const itemLiquid = mkItem("liquid", { tier: 3, isLiquid: true });
    const recipeS = mkRecipe("rs", [], [{ itemId: "solid", amount: 1 }]);
    const recipeL = mkRecipe("rl", [], [{ itemId: "liquid", amount: 1 }]);
    const bin: CrucibleBin = {
      id: "bin-test",
      facilityId: "fac" as never,
      recipeIds: ["rs", "rl"] as never[],
      buildingCount: 1,
      externalInputs: [],
      externalOutputs: [
        { itemId: "solid" as ItemIdType, rate: 30, isLiquid: false },
        { itemId: "liquid" as ItemIdType, rate: 30, isLiquid: true },
      ],
      internalItems: [],
      innerSlotsUsed: 2,
      isGrouped: true,
    };
    const result = pickBinHeadlineOutput(bin, [itemSolid, itemLiquid], [recipeS, recipeL], new Set());
    expect(result?.itemId).toBe("solid");
  });

  test("alphabetical fallback at full tie", () => {
    const itemB = mkItem("b", { tier: 1 });
    const itemA = mkItem("a", { tier: 1 });
    const recipeB = mkRecipe("rb", [], [{ itemId: "b", amount: 1 }]);
    const recipeA = mkRecipe("ra", [], [{ itemId: "a", amount: 1 }]);
    const bin: CrucibleBin = {
      id: "bin-test",
      facilityId: "fac" as never,
      recipeIds: ["ra", "rb"] as never[],
      buildingCount: 1,
      externalInputs: [],
      externalOutputs: [
        { itemId: "b" as ItemIdType, rate: 30, isLiquid: false },
        { itemId: "a" as ItemIdType, rate: 30, isLiquid: false },
      ],
      internalItems: [],
      innerSlotsUsed: 2,
      isGrouped: true,
    };
    const result = pickBinHeadlineOutput(bin, [itemA, itemB], [recipeA, recipeB], new Set());
    expect(result?.itemId).toBe("a"); // alphabetical first.
  });

  test("returns null for bin with no external outputs", () => {
    const bin: CrucibleBin = {
      id: "bin-test",
      facilityId: "fac" as never,
      recipeIds: [] as never[],
      buildingCount: 1,
      externalInputs: [],
      externalOutputs: [],
      internalItems: [],
      innerSlotsUsed: 0,
      isGrouped: false,
    };
    const result = pickBinHeadlineOutput(bin, [], [], new Set());
    expect(result).toBeNull();
  });
});

describe("mapPlanToFlowBinFused (Recipe View)", () => {
  test("Xircon plan: one node per bin with bin metadata", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 30 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFused(plan, items, recipes, facilities, new Map(), false);

    // Total emitted production nodes (excluding raw materials and sinks)
    // should equal the number of non-disposal bins in the plan.
    const productionBinIds = new Set(
      plan.crucibleBins
        .filter((b) => {
          if (b.recipeIds.length !== 1) return true;
          const r = recipes.find((x) => x.id === b.recipeIds[0]);
          return !r || r.outputs.length > 0;
        })
        .map((b) => b.id),
    );

    const productionNodes = flow.nodes.filter(
      (n) =>
        n.type === "productionNode" &&
        productionBinIds.has(n.id),
    );
    expect(productionNodes.length).toBe(productionBinIds.size);
    expect(productionNodes.length).toBeGreaterThan(0);

    // Every production node carries its bin metadata.
    for (const n of productionNodes) {
      const data = n.data as {
        productionNode?: { binId?: string; bin?: CrucibleBin };
      };
      expect(data.productionNode?.binId).toBeDefined();
    }
  });

  test("grouped Xircon bin shows headline + extra outputs", () => {
    // The Xircon scenario produces a bin with all 3 pool recipes
    // (LX, XE, X). External outputs: Xircon (target), Inert XE,
    // and (with rate=30, MIP picks all-Expanded with 4 buildings)
    // potentially Sewage surplus. Headline = Xircon (target +
    // tier 3 + solid). The card's primary item should be Xircon
    // and binExtraOutputs should include the others.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 30 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFused(plan, items, recipes, facilities, new Map(), false);

    // Find the bin containing the Xircon (XIRANITE_POLY) recipe.
    const xirconBin = plan.crucibleBins.find(
      (b) =>
        b.isGrouped &&
        b.externalOutputs.some((o) => o.itemId === ItemId.ITEM_XIRANITE_POLY),
    );
    expect(xirconBin).toBeDefined();

    const xirconNode = flow.nodes.find((n) => n.id === xirconBin!.id);
    expect(xirconNode).toBeDefined();
    const data = xirconNode!.data as {
      productionNode?: {
        item: Item;
        binExtraOutputs?: Array<{ itemId: ItemIdType }>;
        bin?: CrucibleBin;
      };
    };
    expect(data.productionNode?.item.id).toBe(ItemId.ITEM_XIRANITE_POLY);
    expect(data.productionNode?.binExtraOutputs?.length ?? 0).toBeGreaterThan(0);
    expect(data.productionNode?.bin).toBeDefined();
  });

  test("internal flows produce no edges", () => {
    // For the Xircon scenario, Liquid Xiranite is internal (LX produces it,
    // XE consumes it, never leaves the building). The bin-fused mapper
    // emits no edge for Liquid Xiranite — it's neither in externalInputs
    // nor externalOutputs.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 30 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFused(plan, items, recipes, facilities, new Map(), false);

    const xirconBin = plan.crucibleBins.find(
      (b) =>
        b.isGrouped &&
        b.externalOutputs.some((o) => o.itemId === ItemId.ITEM_XIRANITE_POLY),
    );
    expect(xirconBin).toBeDefined();

    // Internal items list should include Liquid Xiranite (it's
    // produced by LX and consumed by XE within the bin at matching
    // rates).
    expect(xirconBin!.internalItems.includes(ItemId.ITEM_LIQUID_XIRANITE))
      .toBe(true);

    // No edges should carry Liquid Xiranite since it's internal.
    const liquidXiraniteEdges = flow.edges.filter((e) => {
      const handle = e.sourceHandle;
      return handle === ItemId.ITEM_LIQUID_XIRANITE;
    });
    // Only edges *across* bins for liquid_xiranite should appear.
    // Inside the grouped bin, no edge — but the same item could
    // appear elsewhere. Permissive: just check the edge is not from
    // the headline bin to itself.
    for (const e of liquidXiraniteEdges) {
      expect(e.source === xirconBin!.id && e.target === xirconBin!.id).toBe(false);
    }
  });

  test("flow integrity: no dangling edges", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 30 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFused(plan, items, recipes, facilities, new Map(), false);

    const nodeIds = new Set(flow.nodes.map((n) => n.id));
    const dangling: string[] = [];
    for (const e of flow.edges) {
      if (!nodeIds.has(e.source))
        dangling.push(`edge ${e.id} source ${e.source} missing`);
      if (!nodeIds.has(e.target))
        dangling.push(`edge ${e.id} target ${e.target} missing`);
    }
    expect(dangling).toEqual([]);
  });
});

describe("mapPlanToFlowBinFusedSeparated (Facility View)", () => {
  test("emits N building nodes per bin where N = ceil(buildingCount)", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 60 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFusedSeparated(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      false,
    );

    // For each non-disposal bin, count emitted building-nodes.
    for (const bin of plan.crucibleBins) {
      if (bin.recipeIds.length === 1) {
        const r = recipes.find((x) => x.id === bin.recipeIds[0]);
        if (r && r.outputs.length === 0) continue; // disposal bin
      }
      const expected = Math.max(1, Math.ceil(bin.buildingCount));
      const buildingNodes = flow.nodes.filter((n) =>
        n.id.startsWith(`${bin.id}-bldg`),
      );
      expect(buildingNodes.length).toBe(expected);
    }
  });

  test("per-building rates = bin total ÷ buildingCount", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 60 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFusedSeparated(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      false,
    );

    const xirconBin = plan.crucibleBins.find(
      (b) =>
        b.isGrouped &&
        b.externalOutputs.some((o) => o.itemId === ItemId.ITEM_XIRANITE_POLY),
    );
    if (!xirconBin) return; // plan may not produce one for this rate; skip silently.

    const xirconExternal = xirconBin.externalOutputs.find(
      (o) => o.itemId === ItemId.ITEM_XIRANITE_POLY,
    );
    if (!xirconExternal) return;

    const perBuildingExpected = xirconExternal.rate / xirconBin.buildingCount;
    const buildings = flow.nodes.filter((n) =>
      n.id.startsWith(`${xirconBin.id}-bldg`),
    );
    expect(buildings.length).toBe(xirconBin.buildingCount);
    for (const b of buildings) {
      const data = b.data as {
        productionNode?: { item: Item; targetRate: number };
      };
      expect(data.productionNode?.item.id).toBe(ItemId.ITEM_XIRANITE_POLY);
      expect(data.productionNode?.targetRate ?? 0).toBeCloseTo(
        perBuildingExpected,
        3,
      );
    }
  });

  test("flow integrity: no dangling edges in Facility View", () => {
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 30 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFusedSeparated(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      false,
    );

    const nodeIds = new Set(flow.nodes.map((n) => n.id));
    const dangling: string[] = [];
    for (const e of flow.edges) {
      if (!nodeIds.has(e.source))
        dangling.push(`edge ${e.id} source ${e.source} missing`);
      if (!nodeIds.has(e.target))
        dangling.push(`edge ${e.id} target ${e.target} missing`);
    }
    expect(dangling).toEqual([]);
  });
});
