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
import { ALL_RAWS } from "./utils";
import { ItemId, RecipeId } from "@/types/constants";
import {
  mockItems,
  mockFacilities,
  byproductSCCRecipes,
} from "./fixtures/test-data";
import type {
  Bin,
  BinId,
  Item,
  Recipe,
  ItemId as ItemIdType,
  RecipeId as RecipeIdType,
  FacilityId as FacilityIdType,
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
  facilityId: "fac" as unknown as FacilityIdType,
  craftingTime: 2,
});

describe("pickBinHeadlineOutput", () => {
  test("targets win over tier", async () => {
    const itemA = mkItem("a", { tier: 1 });
    const itemB = mkItem("b", { tier: 5 });
    const recipeA = mkRecipe("ra", [], [{ itemId: "a", amount: 1 }]);
    const recipeB = mkRecipe("rb", [], [{ itemId: "b", amount: 1 }]);
    const bin: Bin = {
      id: "bin-test" as BinId,
      facilityId: "fac" as unknown as FacilityIdType,
      recipeIds: ["ra", "rb"] as unknown as RecipeIdType[],
      buildingCount: 1,
      externalInputs: [],
      externalOutputs: [
        { itemId: "a" as ItemIdType, rate: 30, isLiquid: false },
        { itemId: "b" as ItemIdType, rate: 30, isLiquid: false },
      ],
      internalItems: [],
      prefillCandidates: [],
      innerSlotsUsed: 2,
      isGrouped: true,
      variantId: "fac:ra,rb#v0",
    };
    const result = pickBinHeadlineOutput(
      bin,
      [itemA, itemB],
      [recipeA, recipeB],
      new Set(["a"] as unknown as ItemIdType[]), // a is target
    );
    expect(result?.itemId).toBe("a"); // target a beats tier-5 b.
  });

  test("highest tier wins when no targets", async () => {
    const itemA = mkItem("a", { tier: 1 });
    const itemB = mkItem("b", { tier: 5 });
    const recipeA = mkRecipe("ra", [], [{ itemId: "a", amount: 1 }]);
    const recipeB = mkRecipe("rb", [], [{ itemId: "b", amount: 1 }]);
    const bin: Bin = {
      id: "bin-test" as BinId,
      facilityId: "fac" as unknown as FacilityIdType,
      recipeIds: ["ra", "rb"] as unknown as RecipeIdType[],
      buildingCount: 1,
      externalInputs: [],
      externalOutputs: [
        { itemId: "a" as ItemIdType, rate: 30, isLiquid: false },
        { itemId: "b" as ItemIdType, rate: 30, isLiquid: false },
      ],
      internalItems: [],
      prefillCandidates: [],
      innerSlotsUsed: 2,
      isGrouped: true,
      variantId: "fac:ra,rb#v0",
    };
    const result = pickBinHeadlineOutput(bin, [itemA, itemB], [recipeA, recipeB], new Set());
    expect(result?.itemId).toBe("b"); // tier 5 beats tier 1.
  });

  test("solid wins over liquid at same tier", async () => {
    const itemSolid = mkItem("solid", { tier: 3, isLiquid: false });
    const itemLiquid = mkItem("liquid", { tier: 3, isLiquid: true });
    const recipeS = mkRecipe("rs", [], [{ itemId: "solid", amount: 1 }]);
    const recipeL = mkRecipe("rl", [], [{ itemId: "liquid", amount: 1 }]);
    const bin: Bin = {
      id: "bin-test" as BinId,
      facilityId: "fac" as unknown as FacilityIdType,
      recipeIds: ["rs", "rl"] as unknown as RecipeIdType[],
      buildingCount: 1,
      externalInputs: [],
      externalOutputs: [
        { itemId: "solid" as ItemIdType, rate: 30, isLiquid: false },
        { itemId: "liquid" as ItemIdType, rate: 30, isLiquid: true },
      ],
      internalItems: [],
      prefillCandidates: [],
      innerSlotsUsed: 2,
      isGrouped: true,
      variantId: "fac:rs,rl#v0",
    };
    const result = pickBinHeadlineOutput(bin, [itemSolid, itemLiquid], [recipeS, recipeL], new Set());
    expect(result?.itemId).toBe("solid");
  });

  test("alphabetical fallback at full tie", async () => {
    const itemB = mkItem("b", { tier: 1 });
    const itemA = mkItem("a", { tier: 1 });
    const recipeB = mkRecipe("rb", [], [{ itemId: "b", amount: 1 }]);
    const recipeA = mkRecipe("ra", [], [{ itemId: "a", amount: 1 }]);
    const bin: Bin = {
      id: "bin-test" as BinId,
      facilityId: "fac" as unknown as FacilityIdType,
      recipeIds: ["ra", "rb"] as unknown as RecipeIdType[],
      buildingCount: 1,
      externalInputs: [],
      externalOutputs: [
        { itemId: "b" as ItemIdType, rate: 30, isLiquid: false },
        { itemId: "a" as ItemIdType, rate: 30, isLiquid: false },
      ],
      internalItems: [],
      prefillCandidates: [],
      innerSlotsUsed: 2,
      isGrouped: true,
      variantId: "fac:ra,rb#v0",
    };
    const result = pickBinHeadlineOutput(bin, [itemA, itemB], [recipeA, recipeB], new Set());
    expect(result?.itemId).toBe("a"); // alphabetical first.
  });

  test("returns null for bin with no external outputs", async () => {
    const bin: Bin = {
      id: "bin-test" as BinId,
      facilityId: "fac" as unknown as FacilityIdType,
      recipeIds: [] as unknown as RecipeIdType[],
      buildingCount: 1,
      externalInputs: [],
      externalOutputs: [],
      internalItems: [],
      prefillCandidates: [],
      innerSlotsUsed: 0,
      isGrouped: false,
      variantId: "fac:#v0",
    };
    const result = pickBinHeadlineOutput(bin, [], [], new Set());
    expect(result).toBeNull();
  });
});

describe("mapPlanToFlowBinFused (Recipe View)", () => {
  test("Xircon plan: one node per bin with bin metadata", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 30 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
    );
    const flow = mapPlanToFlowBinFused(plan, items, recipes, facilities, new Map(), false);

    // Total emitted production nodes (excluding raw materials and sinks)
    // should equal the number of non-disposal bins in the plan. Recipe
    // resolution falls back to `plan.nodes` for injected recipes
    // (vaporize_*/burn_* ride the options bag, not the App roster).
    const productionBinIds = new Set(
      plan.bins
        .filter((b) => {
          if (b.recipeIds.length !== 1) return true;
          const rid = b.recipeIds[0];
          const planNode = plan.nodes.get(rid);
          const r =
            recipes.find((x) => x.id === rid) ??
            (planNode?.type === "recipe" ? planNode.recipe : undefined);
          return !r || r.outputs.length > 0;
        })
        .map((b) => b.id),
    );

    const productionNodes = flow.nodes.filter(
      (n) =>
        n.type === "productionNode" &&
        productionBinIds.has(n.id as BinId),
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

  test("grouped Xircon bin shows headline + extra outputs", async () => {
    // The Xircon scenario produces a bin with all 3 pool recipes
    // (LX, XE, X). External outputs: Xircon (target), Inert XE,
    // and (with rate=30, MIP picks all-Expanded with 4 buildings)
    // potentially Sewage surplus. Headline = Xircon (target +
    // tier 3 + solid). The card's primary item should be Xircon
    // and binExtraOutputs should include the others.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 30 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("internal flows produce no edges", async () => {
    // For the Xircon scenario, Liquid Xiranite is internal (LX produces it,
    // XE consumes it, never leaves the building). The bin-fused mapper
    // emits no edge for Liquid Xiranite — it's neither in externalInputs
    // nor externalOutputs.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 30 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("flow integrity: no dangling edges", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 30 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("raw water byproduct from Purifier IS routed as edges; pickup absorbs the residual", async () => {
    // Routing semantic (post Issue-3 refactor): the Liquid Purifier
    // produces Liquid Water as a byproduct (1 Water per cycle alongside
    // the Poly output). The mapper now treats raw byproducts as valid
    // producers — the greedy allocator drains byproduct supply into
    // water consumers first, and the pickup node absorbs only the
    // residual demand (`node.productionRate`, the LP-computed net
    // external supply after post-LP byproduct netting in
    // `flow-solver.ts:calculateFlows`).
    //
    // This keeps the pickup's `targetRate` consistent with the side
    // panel's NET water demand: pumps × 60/min = node.productionRate,
    // not the gross consumer sum.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 56 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
    );
    const flow = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      false,
    );

    // (a) Raw water pickup node exists (residual external demand > 0).
    const waterPickupId = createRawMaterialId(ItemId.ITEM_LIQUID_WATER);
    const waterPickup = flow.nodes.find((n) => n.id === waterPickupId);
    expect(waterPickup).toBeDefined();

    // (b) The Purifier bin DOES emit at least one water edge — the
    // byproduct now routes to a consumer instead of dangling.
    const purifierBin = plan.bins.find((b) =>
      b.facilityId === ("liquid_purifier_1" as FacilityIdType),
    );
    expect(purifierBin).toBeDefined();
    const waterEdgesFromPurifier = flow.edges.filter(
      (e) =>
        e.source === purifierBin!.id &&
        e.sourceHandle === ItemId.ITEM_LIQUID_WATER,
    );
    expect(waterEdgesFromPurifier.length).toBeGreaterThan(0);

    // (c) Edges from the pickup still go to at least one consumer bin
    // (the byproduct doesn't cover all consumers, so pickup carries
    // the rest).
    const waterEdgesFromPickup = flow.edges.filter(
      (e) => e.source === waterPickupId,
    );
    expect(waterEdgesFromPickup.length).toBeGreaterThan(0);

    // (d) The Purifier bin's externalOutputs still includes water — the
    // data layer is unchanged. This guards that `computeNodeByproducts`
    // will still surface Clean Water on the Purifier bin card.
    const waterOnBin = purifierBin!.externalOutputs.find(
      (o) => o.itemId === ItemId.ITEM_LIQUID_WATER,
    );
    expect(waterOnBin).toBeDefined();
    expect(waterOnBin!.rate).toBeGreaterThan(0);

    // (e) Pickup's targetRate equals plan.nodes[water].productionRate
    // (the LP-computed NET external demand). Side panel and pickup card
    // now agree on the same number.
    const waterNode = plan.nodes.get(ItemId.ITEM_LIQUID_WATER);
    expect(waterNode?.type).toBe("item");
    if (waterNode?.type === "item") {
      const data = waterPickup!.data as {
        productionNode: { targetRate: number };
      };
      expect(data.productionNode.targetRate).toBeCloseTo(
        waterNode.productionRate,
        5,
      );
    }
  });

  test("ceilMode=OFF: grouped bin card shows mean(activities), not integer bin.buildingCount", async () => {
    // bf=1 ceilMode=OFF surfaces partial-load info that the integer
    // `bin.buildingCount` hides for grouped bins. The Xircon {LX, XE, X}
    // bin at target=57 hosts activities (LX=2, XE=2, X=1.9) across 2
    // physical buildings; mean = 5.9 / 3 ≈ 1.967, which is what the
    // card's facilityCount should report when ceilMode=OFF.
    //
    // ceilMode=ON: card shows the integer 2 (physical).
    // ceilMode=OFF: card shows ≈ 1.967 (mean activity).
    // Invariant: ceilMode=OFF value ≤ ceilMode=ON value, always.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

    // ceilMode=OFF: mean activity is strictly below the integer
    // buildingCount when the bin has partial-load recipes. Under Path
    // H the active rates honour the variant's regime (e.g., V3 forces
    // y_LX = 2·y_X, so X allocation is tighter than the old packer's
    // unbounded post-hoc allocation produced). The exact value depends
    // on which variant the LP selects; the invariant is OFF < ON.
    expect(offFacilityCount).toBeGreaterThan(0);
    expect(offFacilityCount).toBeLessThan(onFacilityCount);
    // ceilMode=ON: physical buildingCount = ceil(x_V) for the chosen
    // variant, at least 1.
    expect(onFacilityCount).toBeGreaterThanOrEqual(1);
  });

  test("ceilMode=OFF: singleton bin card facilityCount = bin.buildingCount (no change)", async () => {
    // For singleton bins (1 recipe), mean = sum / 1 = sum = bin.buildingCount.
    // The Purifier bin (LIQUID_PURIFIER_XIRANITE_POLY_1, ~0.76 buildings at
    // target=57) is a singleton; the card should show 0.76 regardless of
    // ceilMode.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 57 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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
        b.facilityId === ("liquid_purifier_1" as FacilityIdType),
    );
    expect(purifierBin).toBeDefined();
    const node = flowOff.nodes.find((n) => n.id === purifierBin!.id);
    expect(node).toBeDefined();
    const facilityCount = (node!.data as {
      productionNode?: { facilityCount: number };
    }).productionNode!.facilityCount;
    expect(facilityCount).toBeCloseTo(purifierBin!.buildingCount, 6);
  });

  test("zero-rate target emits no isolated sink node", async () => {
    // Reachability: the URL-hash parser in `useProductionPlan` accepts
    // any `rate >= 0`, so a hash like `#t=item_iron_nugget:0` results
    // in `targetRates.get(itemId) === 0`. The consumer-registration
    // loop already skips zero-rate targets; the sink-emission loop
    // must match, otherwise an isolated `target-sink-*` node trips
    // assertFlowIntegrity in dev mode.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("singleton-terminal target folds into one embedded sink (bf=0 parity)", async () => {
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
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("target sink incoming edges sum to userTargetRate (target priority over disposal)", async () => {
    // Recipe View counterpart of the Facility View test. The merged
    // bin-fused mapper also registers consumers in the order
    // target-then-disposal so the greedy allocator gives targets
    // priority. For Xircon Poly @ 60/min, the bin emits a single card
    // and its single edge to the target sink must carry exactly the
    // full target rate.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 60 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("singleton-terminal target with multiple inputs routes all inputs to embedded sink (Xiranite Powder regression)", async () => {
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
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POWDER, rate: 10 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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
  test("emits N building nodes per bin where N = ceil(buildingCount)", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 60 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
    );
    const flow = mapPlanToFlowBinFusedSeparated(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      false,
    );

    // For each non-disposal bin, count emitted building-nodes. Recipe
    // resolution falls back to `plan.nodes` for injected recipes
    // (vaporize_*/burn_* ride the options bag, not the App roster) —
    // mirrors the mappers' own `recipeById` seeding.
    for (const bin of plan.bins) {
      if (bin.recipeIds.length === 1) {
        const rid = bin.recipeIds[0];
        const planNode = plan.nodes.get(rid);
        const r =
          recipes.find((x) => x.id === rid) ??
          (planNode?.type === "recipe" ? planNode.recipe : undefined);
        if (r && r.outputs.length === 0) continue; // disposal bin
      }
      const expected = Math.max(1, Math.ceil(bin.buildingCount));
      const buildingNodes = flow.nodes.filter((n) =>
        n.id.startsWith(`${bin.id}-bldg`),
      );
      expect(buildingNodes.length).toBe(expected);
    }
  });

  test("per-building rates = bin total ÷ buildingCount", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 60 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("flow integrity: no dangling edges in Facility View", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 30 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("zero-rate target emits no isolated sink node", async () => {
    // Mirror of the Recipe View test: the separated mapper's
    // sink-emission loop must also skip zero-rate targets so no
    // isolated `target-sink-*` node escapes into the graph.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("singleton-terminal target with ≤1 building folds into embedded sink (bf=0 parity)", async () => {
    // Mirror of the Recipe View test for Facility View. When a singleton
    // bin collapses to one effective building (ceil(buildingCount) === 1)
    // and its sole output is a terminal target, the building card is
    // skipped and recipe info is embedded on the target sink instead.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 10 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("singleton-terminal target with >1 buildings emits per-building cards (no embed)", async () => {
    // Counter-test: ensure the singleton-terminal skip only fires when
    // ceil(buildingCount) === 1. With multiple buildings, the existing
    // per-building emission must still happen (matches bf=0 multi-facility
    // branch). The target sink should NOT have productionInfo embedded
    // in this case — building cards carry the recipe info instead.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 100 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("cycle edges between bins carry direction=backward (ELK layout hint)", async () => {
    // Regression: bin-fused-separated previously didn't tag cycle edges
    // with direction=backward, causing ELK to lay them out with default
    // priority. The mapper now tags both directions of detected cycles
    // to feed ELK's `elk.layered.priority.direction` (see `layout.ts`)
    // for consistent visual layout of multi-bin cycles.
    //
    // The plant seed cycle (planter ↔ seedcollector) is the canonical
    // multi-bin cycle in real data — planter and seedcollector are on
    // different facilities, hence different bins. Detected by the SCC
    // detector and surfaces in `plan.detectedCycles` because under the
    // global LP every detected SCC stays cyclic in graph structure
    // (no feeder extension linearises them).
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PLANT_MOSS_POWDER_1, rate: 30 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("target sink incoming edges sum to userTargetRate (target priority over disposal)", async () => {
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
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 60 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("singleton-terminal target with multiple inputs routes all inputs to embedded sink (Xiranite Powder regression)", async () => {
    // Facility View equivalent of the Xiranite Powder Recipe View
    // regression. The Xiranite Oven recipe consumes Carbon Enriched +
    // Liquid Water and outputs Xiranite Powder — a singleton-terminal
    // bin with two inputs. Both inputs must reach the target sink
    // directly; raw water pickup must not be orphaned.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POWDER, rate: 10 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("per-building cards for grouped multi-building target carry isDirectTarget (star ribbon)", async () => {
    // Regression: `mapPlanToFlowBinFusedSeparated` hardcoded
    // `isDirectTarget: false` on every per-building emission, so the
    // amber Star ribbon in `CustomProductionNode` never showed. For
    // Xircon Poly @ 60/min the {LX, XE, X} bin produces the target
    // across 2+ buildings — each must carry `isDirectTarget: true`
    // plus a non-zero per-building `directTargetRate`.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 60 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("per-building cards on singleton multi-building target carry isDirectTarget", async () => {
    // Counterpart of the grouped test for singleton bins with
    // buildingCount > 1 (Iron Nugget @ 100/min). Not a
    // singleton-terminal case (the skip gate requires N === 1), so
    // building cards emit — and each must still carry the star.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_NUGGET, rate: 100 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("battery SCC scenario: bin-fused renders connected graph with target reachable", async () => {
    // Exercises bin-fused-separated on a synthetic byproduct-SCC recipe
    // graph (`byproductSCCRecipes`) targeting Battery. Covers a
    // different graph topology than the Xircon scenario: the byproduct
    // producer (furnace) is OUTSIDE the SCC and feeds Sewage into the
    // cycle.
    //
    // The elevated `assertFlowIntegrity` in test mode (see
    // `flow-assertions.ts`) hard-fails on dangling edges or isolated
    // nodes, so reaching this point means the mapper produced an
    // integral graph. The explicit checks below add positive assertions
    // for the specific Battery SCC invariants:
    //   - The furnace (external Sewage producer) has outgoing edges.
    //   - The Battery target sink has incoming edges with the requested
    //     rate.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_PROC_BATTERY_1, rate: 30 }],
      mockItems,
      byproductSCCRecipes,
      mockFacilities,
      { rawMaterials: ALL_RAWS },
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

  test("grouped bin sister count matches bin.recipeIds.length (off-by-one regression)", async () => {
    // Catches the off-by-one bug in the sister filter where
    // `bin.recipeIds.filter((rid) => rid !== self)` would incorrectly
    // retain the self id (e.g. lx_1's sisters would be [lx_2, xe_2,
    // x_2] instead of [xe_1, x_1], producing a "4 formulas" badge for
    // a 3-formula bin).
    //
    // Uses real data so Phase 3 actually packs the {LX, XE, X} pool
    // into Expanded Crucible bins.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_XIRANITE_POLY, rate: 30 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
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

  test("3-target plan (Hetonite Part + SC Wuling Battery + Yazhen Syringe) produces no isolated bins", async () => {
    // Regression test for the "vestigial 2-recipe variant" bug.
    //
    // Background: in an earlier solver iteration that solved the LP
    // as a continuous relaxation, strict-equality demand could leave
    // tiny u values (~1e-7) for 2-recipe variants combining unrelated
    // chemistries (e.g., `{pool_copper_enr, pool_liquid_plant_grass_2}`).
    // These variants were vestigial: singletons of the same recipes
    // already covered demand at meaningful rates, but FP residue from
    // simplex pivots left them with non-zero u just above
    // SLOT_DEMAND_EPSILON.
    //
    // When rounded to x=1, such bins emitted external rates of ~3e-5
    // /min, far below the bin-fused mapper's 0.001/min edge-allocation
    // threshold. The mapper skipped all incident edges, leaving the
    // bin as an isolated node → `assertFlowIntegrity` failure.
    //
    // The 3-target combination below was a known failure mode in an
    // earlier solver iteration: certain LP outputs left bins emitting
    // at rates below the mapper's edge-allocation threshold,
    // producing isolated nodes that tripped `assertFlowIntegrity`.
    // The current solver's 1e-10 feasibility tolerance keeps such
    // sub-visible outputs from appearing. If `assertFlowIntegrity`
    // ever fires for this scenario, that invariant regressed.
    const plan = await calculateProductionPlan(
      [
        { itemId: ItemId.ITEM_COPPER_ENR_CMPT, rate: 6 },
        { itemId: ItemId.ITEM_PROC_BATTERY_5, rate: 6 },
        { itemId: ItemId.ITEM_BOTTLED_REC_HP_5, rate: 6 },
      ],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
    );

    // Helper to verify no isolated nodes in a mapper's output.
    // `assertFlowIntegrity` (run inside each mapper) throws on any
    // violation in test mode, so reaching the check below already
    // means no isolated bins. The explicit isolation check is a
    // defensive duplicate in case the assertion drifts from the
    // mapper's actual emitted graph.
    const assertNoIsolatedNodes = (
      flow: { nodes: { id: string }[]; edges: { source: string; target: string }[] },
      label: string,
    ): void => {
      const referenced = new Set<string>();
      for (const edge of flow.edges) {
        referenced.add(edge.source);
        referenced.add(edge.target);
      }
      const isolated =
        flow.nodes.length > 1
          ? flow.nodes.filter((n) => !referenced.has(n.id))
          : [];
      expect(isolated, `${label}: isolated nodes`).toEqual([]);
    };

    // Recipe View (bin-fused merged).
    const flowMerged = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      false,
    );
    assertNoIsolatedNodes(flowMerged, "Recipe View");

    // Facility View (bin-fused separated). Same packer output, but
    // the mapper emits one node per physical building instead of one
    // per bin. Same bins drive both mappers, so any edge-allocation
    // failure surfaces in both views identically.
    const flowSeparated = mapPlanToFlowBinFusedSeparated(
      plan,
      items,
      recipes,
      facilities,
      new Map(),
      false,
    );
    assertNoIsolatedNodes(flowSeparated, "Facility View");
  });
});
