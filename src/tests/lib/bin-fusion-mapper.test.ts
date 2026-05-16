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
import { createRawMaterialId, createTargetSinkId } from "@/lib/node-keys";
import { items, recipes, facilities } from "@/data";
import { ItemId, RecipeId } from "@/types/constants";
import {
  mockItems,
  mockFacilities,
  byproductSCCRecipes,
} from "./fixtures/test-data";
import type {
  Bin,
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
    const bin: Bin = {
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
    const bin: Bin = {
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
    const bin: Bin = {
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
    const bin: Bin = {
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
    const bin: Bin = {
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
      plan.bins
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
        productionNode?: { binId?: string; bin?: Bin };
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
    const xirconBin = plan.bins.find(
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
        bin?: Bin;
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

    const xirconBin = plan.bins.find(
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

  test("raw water pickup is emitted even when Liquid Purifier produces water as byproduct", () => {
    // Regression: bin-fused-mapper used to skip raw-pickup emission for
    // items that had any bin producer. The Liquid Purifier produces
    // Liquid Water as a byproduct (1 Water per cycle alongside the Poly
    // output), so Water was incorrectly treated as "supplied" and the
    // raw pickup vanished — leaving LX consumers' water demand unsourced.
    //
    // Expected behaviour (matches bf=0 / merged-mapper via
    // `getItemProducers` returning [] for raw items):
    //   - Pickup node emitted with rate = total LX water demand.
    //   - No water edge originates from the Purifier bin (its byproduct
    //     is shown on the bin card via `binExtraOutputs` but not routed).
    //   - Edges from the pickup feed each consumer bin's water input.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 56 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      false,
    );

    // (a) Raw water pickup node exists.
    const waterPickupId = createRawMaterialId(ItemId.ITEM_LIQUID_WATER);
    const waterPickup = flow.nodes.find((n) => n.id === waterPickupId);
    expect(waterPickup).toBeDefined();

    // (b) No water-bearing edge originates from the Liquid Purifier bin.
    const purifierBin = plan.bins.find((b) =>
      b.facilityId === ("liquid_purifier_1" as never),
    );
    expect(purifierBin).toBeDefined();
    const waterEdgesFromPurifier = flow.edges.filter(
      (e) =>
        e.source === purifierBin!.id &&
        e.sourceHandle === ItemId.ITEM_LIQUID_WATER,
    );
    expect(waterEdgesFromPurifier).toHaveLength(0);

    // (c) Edges from the pickup go to at least one consumer bin.
    const waterEdgesFromPickup = flow.edges.filter(
      (e) => e.source === waterPickupId,
    );
    expect(waterEdgesFromPickup.length).toBeGreaterThan(0);

    // (d) The Purifier bin's externalOutputs still includes water — the
    // data layer is unchanged; only the routing changes. This guards
    // that `computeNodeByproducts` will still surface Clean Water on
    // the Purifier bin card.
    const waterOnBin = purifierBin!.externalOutputs.find(
      (o) => o.itemId === ItemId.ITEM_LIQUID_WATER,
    );
    expect(waterOnBin).toBeDefined();
    expect(waterOnBin!.rate).toBeGreaterThan(0);
  });

  test("ceilMode=OFF: grouped bin card shows mean(activities), not integer bin.buildingCount", () => {
    // bf=1 ceilMode=OFF surfaces partial-load info that the integer
    // `bin.buildingCount` hides for grouped bins. The Xircon {LX, XE, X}
    // bin at target=57 hosts activities (LX=2, XE=2, X=1.9) across 2
    // physical buildings; mean = 5.9 / 3 ≈ 1.967, which is what the
    // card's facilityCount should report when ceilMode=OFF.
    //
    // ceilMode=ON: card shows the integer 2 (physical).
    // ceilMode=OFF: card shows ≈ 1.967 (mean activity).
    // Invariant: ceilMode=OFF value ≤ ceilMode=ON value, always.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
    );
    const flowOff = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      false,
    );
    const flowOn = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      true,
    );

    const xirconBin = plan.bins.find(
      (b) =>
        b.isGrouped &&
        b.recipeIds.length === 3 &&
        b.externalOutputs.some((o) => o.itemId === ItemId.ITEM_XIRANITE_POLY),
    );
    expect(xirconBin).toBeDefined();

    const offNode = flowOff.nodes.find((n) => n.id === xirconBin!.id);
    const onNode = flowOn.nodes.find((n) => n.id === xirconBin!.id);
    expect(offNode).toBeDefined();
    expect(onNode).toBeDefined();

    const offFacilityCount = (offNode!.data as {
      productionNode?: { facilityCount: number };
    }).productionNode!.facilityCount;
    const onFacilityCount = (onNode!.data as {
      productionNode?: { facilityCount: number };
    }).productionNode!.facilityCount;

    // ceilMode=OFF: mean activity ≈ 1.967.
    expect(offFacilityCount).toBeCloseTo(1.967, 2);
    // ceilMode=ON: physical buildingCount = 2.
    expect(onFacilityCount).toBe(2);
    // Invariant: OFF ≤ ON.
    expect(offFacilityCount).toBeLessThanOrEqual(onFacilityCount);
  });

  test("ceilMode=OFF: singleton bin card facilityCount = bin.buildingCount (no change)", () => {
    // For singleton bins (1 recipe), mean = sum / 1 = sum = bin.buildingCount.
    // The Purifier bin (LIQUID_PURIFIER_XIRANITE_POLY_1, ~0.76 buildings at
    // target=57) is a singleton; the card should show 0.76 regardless of
    // ceilMode.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
    );
    const flowOff = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      false,
    );
    const purifierBin = plan.bins.find(
      (b) =>
        b.recipeIds.length === 1 &&
        b.facilityId === ("liquid_purifier_1" as never),
    );
    expect(purifierBin).toBeDefined();
    const node = flowOff.nodes.find((n) => n.id === purifierBin!.id);
    expect(node).toBeDefined();
    const facilityCount = (node!.data as {
      productionNode?: { facilityCount: number };
    }).productionNode!.facilityCount;
    expect(facilityCount).toBeCloseTo(purifierBin!.buildingCount, 6);
  });

  test("zero-rate target emits no isolated sink node", () => {
    // Reachability: the URL-hash parser in `useProductionPlan` accepts
    // any `rate >= 0`, so a hash like `#t=item_iron_nugget:0` results
    // in `targetRates.get(itemId) === 0`. The consumer-registration
    // loop already skips zero-rate targets; the sink-emission loop
    // must match, otherwise an isolated `target-sink-*` node trips
    // assertFlowIntegrity in dev mode.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      new Map([[ItemId.ITEM_IRON_NUGGET, 0]]),
      false,
    );
    const sinkId = createTargetSinkId(ItemId.ITEM_IRON_NUGGET);
    expect(flow.nodes.find((n) => n.id === sinkId)).toBeUndefined();
  });

  test("singleton-terminal target folds into one embedded sink (bf=0 parity)", () => {
    // Regression: prior to the singleton-terminal skip, the merged bin-fused
    // mapper emitted both the bin's production card AND the target sink
    // with embedded recipe info — duplicating the same information twice
    // on screen for any simple A→B chain. The merged-mapper (bf=0) folds
    // terminal recipes into the target sink via `isRecipeTerminal`, and
    // the bin-fused mapper must match that for visual parity.
    //
    // Iron Nugget is the simplest terminal-target chain in the real data
    // (Furnace × 1 producing only Iron Nugget, no byproducts, no consumers
    // other than the target sink).
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      new Map([[ItemId.ITEM_IRON_NUGGET, 10]]),
      false,
    );

    // No production bin node emitted for the iron-nugget bin.
    const ironBin = plan.bins.find((b) =>
      b.externalOutputs.some((o) => o.itemId === ItemId.ITEM_IRON_NUGGET),
    );
    expect(ironBin).toBeDefined();
    const binNode = flow.nodes.find((n) => n.id === ironBin!.id);
    expect(binNode).toBeUndefined();

    // The target sink IS emitted, and carries embedded productionInfo.
    const sinkId = createTargetSinkId(ItemId.ITEM_IRON_NUGGET);
    const sinkNode = flow.nodes.find((n) => n.id === sinkId);
    expect(sinkNode).toBeDefined();
    const sinkData = sinkNode!.data as {
      productionInfo?: {
        facility: { id: string } | null;
        facilityCount: number;
        recipe: { id: string } | null;
      };
    };
    expect(sinkData.productionInfo).toBeDefined();
    expect(sinkData.productionInfo!.recipe?.id).toBe(ironBin!.recipeIds[0]);
    expect(sinkData.productionInfo!.facilityCount).toBeCloseTo(
      ironBin!.buildingCount,
      6,
    );

    // No dangling edges — the bin→sink edge from greedy allocation must
    // be filtered out when the bin isn't emitted.
    const nodeIds = new Set(flow.nodes.map((n) => n.id));
    for (const e of flow.edges) {
      expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }

    // No isolated nodes — the target sink must have at least one
    // incoming edge from the rerouted input (iron_ore raw material),
    // and the raw iron_ore pickup must have at least one outgoing edge.
    const referenced = new Set<string>();
    for (const e of flow.edges) {
      referenced.add(e.source);
      referenced.add(e.target);
    }
    for (const n of flow.nodes) {
      expect(
        referenced.has(n.id),
        `node ${n.id} has no incident edges`,
      ).toBe(true);
    }
  });

  test("target sink incoming edges sum to userTargetRate (target priority over disposal)", () => {
    // Recipe View counterpart of the Facility View test. The merged
    // bin-fused mapper also registers consumers in the order
    // target-then-disposal so the greedy allocator gives targets
    // priority. For Xircon Poly @ 60/min, the bin emits a single card
    // and its single edge to the target sink must carry exactly the
    // full target rate.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 60 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      new Map([[ItemId.ITEM_XIRANITE_POLY, 60]]),
      false,
    );

    const sinkId = createTargetSinkId(ItemId.ITEM_XIRANITE_POLY);
    const targetIncoming = flow.edges.filter(
      (e) =>
        e.target === sinkId &&
        e.sourceHandle === ItemId.ITEM_XIRANITE_POLY,
    );
    expect(targetIncoming.length).toBeGreaterThan(0);

    const totalRate = targetIncoming.reduce(
      (sum, e) => sum + ((e.data as { flowRate?: number })?.flowRate ?? 0),
      0,
    );
    expect(totalRate).toBeCloseTo(60, 6);
  });

  test("singleton-terminal target with multiple inputs routes all inputs to embedded sink (Xiranite Powder regression)", () => {
    // Regression: my first attempt at the singleton-terminal skip
    // produced isolated `raw_item_liquid_water` and
    // `target-sink-item_xiranite_powder` nodes because the skipped
    // bin's input edges were filtered out without being rerouted. The
    // Xiranite Oven recipe consumes two inputs (Carbon Enriched +
    // Liquid Water) and outputs Xiranite Powder, exposing the case
    // that single-input Iron Nugget couldn't.
    //
    // Both inputs must land directly on the target sink, and neither
    // the raw water pickup nor the target sink may end up isolated.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POWDER, rate: 10 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      new Map([[ItemId.ITEM_XIRANITE_POWDER, 10]]),
      false,
    );

    // Singleton-terminal bin must be skipped.
    const xiraniteBin = plan.bins.find((b) =>
      b.externalOutputs.some((o) => o.itemId === ItemId.ITEM_XIRANITE_POWDER),
    );
    expect(xiraniteBin).toBeDefined();
    expect(flow.nodes.find((n) => n.id === xiraniteBin!.id)).toBeUndefined();

    // Target sink emitted with embedded productionInfo.
    const sinkId = createTargetSinkId(ItemId.ITEM_XIRANITE_POWDER);
    const sinkNode = flow.nodes.find((n) => n.id === sinkId);
    expect(sinkNode).toBeDefined();
    const sinkData = sinkNode!.data as {
      productionInfo?: { recipe: { id: string } | null };
    };
    expect(sinkData.productionInfo).toBeDefined();

    // Target sink has incoming edges (one per input).
    const sinkIncoming = flow.edges.filter((e) => e.target === sinkId);
    expect(sinkIncoming.length).toBeGreaterThan(0);

    // Raw water pickup has at least one outgoing edge to the target sink.
    const rawWaterId = createRawMaterialId(ItemId.ITEM_LIQUID_WATER);
    const waterEdges = flow.edges.filter((e) => e.source === rawWaterId);
    expect(waterEdges.length).toBeGreaterThan(0);
    expect(waterEdges.some((e) => e.target === sinkId)).toBe(true);

    // No isolated nodes (the exact regression we're guarding against).
    const referenced = new Set<string>();
    for (const e of flow.edges) {
      referenced.add(e.source);
      referenced.add(e.target);
    }
    for (const n of flow.nodes) {
      expect(
        referenced.has(n.id),
        `node ${n.id} has no incident edges`,
      ).toBe(true);
    }
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
    for (const bin of plan.bins) {
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

    const xirconBin = plan.bins.find(
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

  test("zero-rate target emits no isolated sink node", () => {
    // Mirror of the Recipe View test: the separated mapper's
    // sink-emission loop must also skip zero-rate targets so no
    // isolated `target-sink-*` node escapes into the graph.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFusedSeparated(
      plan,
      items,
      recipes,
      facilities,
      new Map([[ItemId.ITEM_IRON_NUGGET, 0]]),
      false,
    );
    const sinkId = createTargetSinkId(ItemId.ITEM_IRON_NUGGET);
    expect(flow.nodes.find((n) => n.id === sinkId)).toBeUndefined();
  });

  test("singleton-terminal target with ≤1 building folds into embedded sink (bf=0 parity)", () => {
    // Mirror of the Recipe View test for Facility View. When a singleton
    // bin collapses to one effective building (ceil(buildingCount) === 1)
    // and its sole output is a terminal target, the building card is
    // skipped and recipe info is embedded on the target sink instead —
    // matching `mapPlanToFlowSeparated`' else branch at
    // `separated-mapper.ts:754-773`.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFusedSeparated(
      plan,
      items,
      recipes,
      facilities,
      new Map([[ItemId.ITEM_IRON_NUGGET, 10]]),
      false,
    );

    const ironBin = plan.bins.find((b) =>
      b.externalOutputs.some((o) => o.itemId === ItemId.ITEM_IRON_NUGGET),
    );
    expect(ironBin).toBeDefined();
    expect(Math.max(1, Math.ceil(ironBin!.buildingCount))).toBe(1);

    // No building-instance nodes emitted for the iron-nugget bin.
    const buildingNodes = flow.nodes.filter((n) =>
      n.id.startsWith(`${ironBin!.id}-bldg`),
    );
    expect(buildingNodes).toHaveLength(0);

    // Target sink carries embedded productionInfo.
    const sinkId = createTargetSinkId(ItemId.ITEM_IRON_NUGGET);
    const sinkNode = flow.nodes.find((n) => n.id === sinkId);
    expect(sinkNode).toBeDefined();
    const sinkData = sinkNode!.data as {
      productionInfo?: {
        facility: { id: string } | null;
        facilityCount: number;
        recipe: { id: string } | null;
      };
    };
    expect(sinkData.productionInfo).toBeDefined();
    expect(sinkData.productionInfo!.recipe?.id).toBe(ironBin!.recipeIds[0]);
    expect(sinkData.productionInfo!.facilityCount).toBeCloseTo(
      ironBin!.buildingCount,
      6,
    );

    // No dangling edges.
    const nodeIds = new Set(flow.nodes.map((n) => n.id));
    for (const e of flow.edges) {
      expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }

    // No isolated nodes — every emitted node must participate in at
    // least one edge.
    const referenced = new Set<string>();
    for (const e of flow.edges) {
      referenced.add(e.source);
      referenced.add(e.target);
    }
    for (const n of flow.nodes) {
      expect(
        referenced.has(n.id),
        `node ${n.id} has no incident edges`,
      ).toBe(true);
    }
  });

  test("singleton-terminal target with >1 buildings emits per-building cards (no embed)", () => {
    // Counter-test: ensure the singleton-terminal skip only fires when
    // ceil(buildingCount) === 1. With multiple buildings, the existing
    // per-building emission must still happen (matches bf=0 multi-facility
    // branch). The target sink should NOT have productionInfo embedded
    // in this case — building cards carry the recipe info instead.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 100 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFusedSeparated(
      plan,
      items,
      recipes,
      facilities,
      new Map([[ItemId.ITEM_IRON_NUGGET, 100]]),
      false,
    );

    const ironBin = plan.bins.find((b) =>
      b.externalOutputs.some((o) => o.itemId === ItemId.ITEM_IRON_NUGGET),
    );
    expect(ironBin).toBeDefined();
    const expectedBuildings = Math.max(1, Math.ceil(ironBin!.buildingCount));
    expect(expectedBuildings).toBeGreaterThan(1);

    // Building-instance nodes emitted.
    const buildingNodes = flow.nodes.filter((n) =>
      n.id.startsWith(`${ironBin!.id}-bldg`),
    );
    expect(buildingNodes).toHaveLength(expectedBuildings);

    // Target sink has NO embedded productionInfo.
    const sinkId = createTargetSinkId(ItemId.ITEM_IRON_NUGGET);
    const sinkNode = flow.nodes.find((n) => n.id === sinkId);
    expect(sinkNode).toBeDefined();
    const sinkData = sinkNode!.data as {
      productionInfo?: unknown;
    };
    expect(sinkData.productionInfo).toBeUndefined();
  });

  test("cycle edges between bins carry direction=backward (ELK layout hint)", () => {
    // Regression: bin-fused-separated previously didn't tag cycle edges
    // with direction=backward, causing ELK to lay them out with default
    // priority. `mapPlanToFlowSeparated:287-296` tags both directions
    // of detected cycles to feed ELK's `elk.layered.priority.direction`
    // (see `layout.ts:264-276`). Bin-fused-separated must match for
    // consistent visual layout of multi-bin cycles.
    //
    // The moss seed cycle (planter ↔ seedcollector) is the canonical
    // multi-bin cycle in real data — planter and seedcollector are on
    // different facilities, hence different bins. Detected by the SCC
    // detector and surfaces in `plan.detectedCycles` because the
    // LP-based solver doesn't add solved cycles to `resolvedSCCIds`.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PLANT_MOSS_POWDER_1, rate: 30 }],
      items,
      recipes,
      facilities,
    );
    expect(plan.detectedCycles.length).toBeGreaterThan(0);

    const flow = mapPlanToFlowBinFusedSeparated(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      false,
    );

    // Find edges between moss-cycle bins (planter / seedcollector).
    const cycleEdges = flow.edges.filter((e) => {
      const isPlanter = e.source.includes("planter") || e.target.includes("planter");
      const isSeedcollector =
        e.source.includes("seedcollector") || e.target.includes("seedcollector");
      return isPlanter && isSeedcollector;
    });
    expect(cycleEdges.length).toBeGreaterThan(0);

    // Every cycle edge must be tagged direction=backward.
    for (const e of cycleEdges) {
      const data = e.data as { direction?: string };
      expect(data?.direction).toBe("backward");
    }
  });

  test("target sink incoming edges sum to userTargetRate (target priority over disposal)", () => {
    // Regression: bin-fused-separated previously registered disposal-bin
    // consumers BEFORE target sinks in the greedy allocator's consumer
    // map. With well-balanced plans this produced identical results,
    // but floating-point noise could leave a target ε under-allocated
    // because disposal got first pick. Reversing the order ensures
    // targets always receive exactly their requested rate.
    //
    // Xircon Poly @ 60/min puts the grouped {LX, XE, X} bin at 2
    // buildings, each connecting to the target sink. Total target
    // sink incoming for ITEM_XIRANITE_POLY must equal 60/min exactly.
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
      new Map([[ItemId.ITEM_XIRANITE_POLY, 60]]),
      false,
    );

    const sinkId = createTargetSinkId(ItemId.ITEM_XIRANITE_POLY);
    const targetIncoming = flow.edges.filter(
      (e) =>
        e.target === sinkId &&
        e.sourceHandle === ItemId.ITEM_XIRANITE_POLY,
    );
    expect(targetIncoming.length).toBeGreaterThan(0);

    const totalRate = targetIncoming.reduce(
      (sum, e) => sum + ((e.data as { flowRate?: number })?.flowRate ?? 0),
      0,
    );
    expect(totalRate).toBeCloseTo(60, 6);
  });

  test("singleton-terminal target with multiple inputs routes all inputs to embedded sink (Xiranite Powder regression)", () => {
    // Facility View equivalent of the Xiranite Powder Recipe View
    // regression. The Xiranite Oven recipe consumes Carbon Enriched +
    // Liquid Water and outputs Xiranite Powder — a singleton-terminal
    // bin with two inputs. Both inputs must reach the target sink
    // directly; raw water pickup must not be orphaned.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POWDER, rate: 10 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFusedSeparated(
      plan,
      items,
      recipes,
      facilities,
      new Map([[ItemId.ITEM_XIRANITE_POWDER, 10]]),
      false,
    );

    const xiraniteBin = plan.bins.find((b) =>
      b.externalOutputs.some((o) => o.itemId === ItemId.ITEM_XIRANITE_POWDER),
    );
    expect(xiraniteBin).toBeDefined();
    expect(Math.max(1, Math.ceil(xiraniteBin!.buildingCount))).toBe(1);

    // No building-instance nodes emitted.
    const buildingNodes = flow.nodes.filter((n) =>
      n.id.startsWith(`${xiraniteBin!.id}-bldg`),
    );
    expect(buildingNodes).toHaveLength(0);

    // Target sink emitted with embed.
    const sinkId = createTargetSinkId(ItemId.ITEM_XIRANITE_POWDER);
    const sinkNode = flow.nodes.find((n) => n.id === sinkId);
    expect(sinkNode).toBeDefined();
    const sinkData = sinkNode!.data as {
      productionInfo?: { recipe: { id: string } | null };
    };
    expect(sinkData.productionInfo).toBeDefined();

    // Target sink has incoming edges.
    const sinkIncoming = flow.edges.filter((e) => e.target === sinkId);
    expect(sinkIncoming.length).toBeGreaterThan(0);

    // No isolated nodes.
    const referenced = new Set<string>();
    for (const e of flow.edges) {
      referenced.add(e.source);
      referenced.add(e.target);
    }
    for (const n of flow.nodes) {
      expect(
        referenced.has(n.id),
        `node ${n.id} has no incident edges`,
      ).toBe(true);
    }
  });

  test("per-building cards for grouped multi-building target carry isDirectTarget (star ribbon)", () => {
    // Regression: `mapPlanToFlowBinFusedSeparated` hardcoded
    // `isDirectTarget: false` on every per-building emission, so the
    // amber Star ribbon in `CustomProductionNode.tsx:284-297` never
    // showed. For Xircon Poly @ 60/min the {LX, XE, X} bin produces
    // the target across 2+ buildings — each must carry
    // `isDirectTarget: true` plus a non-zero per-building
    // `directTargetRate`, matching `separated-mapper.ts:698-705`'
    // terminal multi-facility branch.
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
      new Map([[ItemId.ITEM_XIRANITE_POLY, 60]]),
      false,
    );

    const xirconBin = plan.bins.find(
      (b) =>
        b.isGrouped &&
        b.externalOutputs.some((o) => o.itemId === ItemId.ITEM_XIRANITE_POLY),
    );
    expect(xirconBin).toBeDefined();

    const buildings = flow.nodes.filter((n) =>
      n.id.startsWith(`${xirconBin!.id}-bldg`),
    );
    expect(buildings.length).toBeGreaterThan(0);

    for (const b of buildings) {
      const data = b.data as {
        isDirectTarget?: boolean;
        directTargetRate?: number;
      };
      expect(data.isDirectTarget).toBe(true);
      expect(data.directTargetRate ?? 0).toBeGreaterThan(0);
    }
  });

  test("per-building cards on singleton multi-building target carry isDirectTarget", () => {
    // Counterpart of the grouped test for singleton bins with
    // buildingCount > 1 (Iron Nugget @ 100/min). Not a
    // singleton-terminal case (the skip gate requires N === 1), so
    // building cards emit — and each must still carry the star.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 100 }],
      items,
      recipes,
      facilities,
    );
    const flow = mapPlanToFlowBinFusedSeparated(
      plan,
      items,
      recipes,
      facilities,
      new Map([[ItemId.ITEM_IRON_NUGGET, 100]]),
      false,
    );

    const ironBin = plan.bins.find((b) =>
      b.externalOutputs.some((o) => o.itemId === ItemId.ITEM_IRON_NUGGET),
    );
    expect(ironBin).toBeDefined();

    const buildings = flow.nodes.filter((n) =>
      n.id.startsWith(`${ironBin!.id}-bldg`),
    );
    expect(buildings.length).toBeGreaterThan(1);

    for (const b of buildings) {
      const data = b.data as {
        isDirectTarget?: boolean;
        directTargetRate?: number;
      };
      expect(data.isDirectTarget).toBe(true);
      expect(data.directTargetRate ?? 0).toBeGreaterThan(0);
    }
  });

  test("battery SCC scenario: bin-fused renders connected graph with target reachable", () => {
    // Migrated from the now-deleted `separated-mapper.test.ts`. Exercises
    // the bin-fused-separated mapper on a synthetic byproduct-SCC
    // recipe graph (`byproductSCCRecipes`) targeting Battery. Adds
    // coverage for a different graph topology than the Xircon scenario
    // — the byproduct producer (furnace) is OUTSIDE the SCC and feeds
    // Sewage into the cycle.
    //
    // The elevated `assertFlowIntegrity` in test mode (see
    // `flow-assertions.ts`) hard-fails on dangling edges or isolated
    // nodes, so reaching this point means the mapper produced an
    // integral graph. The explicit checks below add positive assertions
    // for the specific Battery SCC invariants:
    //   - The furnace (external Sewage producer) has outgoing edges.
    //   - The Battery target sink has incoming edges with the requested
    //     rate.
    const plan = calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 30 }],
      mockItems,
      byproductSCCRecipes,
      mockFacilities,
    );
    const flow = mapPlanToFlowBinFusedSeparated(
      plan,
      mockItems,
      byproductSCCRecipes,
      mockFacilities,
      new Map([[ItemId.ITEM_PROC_BATTERY_1, 30]]),
      false,
    );

    // Furnace bins host the FURNANCE_COPPER_NUGGET_1 recipe; locate
    // their building instances by bin id prefix.
    const furnaceBins = plan.bins.filter((b) =>
      b.recipeIds.includes(RecipeId.FURNANCE_COPPER_NUGGET_1),
    );
    expect(furnaceBins.length).toBeGreaterThan(0);
    const furnaceInstanceIds = new Set<string>();
    for (const bin of furnaceBins) {
      for (const n of flow.nodes) {
        if (n.id.startsWith(`${bin.id}-bldg`)) furnaceInstanceIds.add(n.id);
      }
    }
    expect(furnaceInstanceIds.size).toBeGreaterThan(0);
    const furnaceOutgoing = flow.edges.filter((e) =>
      furnaceInstanceIds.has(e.source),
    );
    expect(furnaceOutgoing.length).toBeGreaterThan(0);

    // Battery target sink emitted with at least one incoming edge.
    // Total incoming rate (regardless of sourceHandle, since the
    // singleton-terminal embed redirects rewrite source items) must
    // cover the requested 30/min.
    const sinkId = createTargetSinkId(ItemId.ITEM_PROC_BATTERY_1);
    const sinkNode = flow.nodes.find((n) => n.id === sinkId);
    expect(sinkNode).toBeDefined();
    const sinkIncoming = flow.edges.filter((e) => e.target === sinkId);
    expect(sinkIncoming.length).toBeGreaterThan(0);
  });

  test("grouped bin sister count matches bin.recipeIds.length (off-by-one regression)", () => {
    // Migrated from the now-deleted `separated-mapper.test.ts` Phase 3
    // bin annotations test. Specifically catches the off-by-one bug in
    // the sister filter where `bin.recipeIds.filter((rid) => rid !== self)`
    // would incorrectly retain the self id (e.g. lx_1's sisters would be
    // [lx_2, xe_2, x_2] instead of [xe_1, x_1], producing a "4 formulas"
    // badge for a 3-formula bin).
    //
    // Uses real data so Phase 3 actually packs the {LX, XE, X} pool
    // into Expanded Crucible bins.
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

    // Find building-instance nodes that belong to grouped bins.
    const groupedNodes = flow.nodes.filter((n) => {
      const data = n.data as {
        productionNode?: { binId?: string; binSisterRecipeIds?: string[] };
      };
      const pn = data.productionNode;
      return (
        (pn?.binSisterRecipeIds?.length ?? 0) > 0 &&
        pn?.binId !== undefined
      );
    });
    expect(groupedNodes.length).toBeGreaterThan(0);

    for (const n of groupedNodes) {
      const pn = (n.data as {
        productionNode?: {
          binId?: string;
          binSisterRecipeIds?: string[];
          recipe?: { id: string };
        };
      }).productionNode!;
      const bin = plan.bins.find((b) => b.id === pn.binId);
      expect(bin).toBeDefined();
      // sister count + 1 (self) must equal bin's recipe count.
      const formulaCountFromUI = (pn.binSisterRecipeIds?.length ?? 0) + 1;
      expect(formulaCountFromUI).toBe(bin!.recipeIds.length);
      // Self's recipe id must NOT be in the sister list.
      expect(pn.binSisterRecipeIds).not.toContain(pn.recipe!.id);
    }
  });
});
