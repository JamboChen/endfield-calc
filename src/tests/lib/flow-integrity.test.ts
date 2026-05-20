import { describe, test, expect, beforeAll } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { mapPlanToFlowMerged } from "@/components/mappers/merged-mapper";
import {
  mapPlanToFlowBinFused,
  mapPlanToFlowBinFusedSeparated,
} from "@/components/mappers/bin-fused-mapper";
import { items, recipes, facilities } from "@/data";
import type { FacilityId, ItemId, ProductionDependencyGraph } from "@/types";
import type { Edge, Node } from "@xyflow/react";

function checkIntegrity(nodes: Node[], edges: Edge[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const dangling: string[] = [];
  const referenced = new Set<string>();
  for (const e of edges) {
    if (!ids.has(e.source)) dangling.push(`edge ${e.id} source ${e.source} missing`);
    if (!ids.has(e.target)) dangling.push(`edge ${e.id} target ${e.target} missing`);
    referenced.add(e.source);
    referenced.add(e.target);
  }
  const isolated = nodes.filter((n) => !referenced.has(n.id)).map((n) => n.id);
  return { dangling, isolated };
}

const cases: { name: string; targetId: ItemId; rate: number }[] = [
  { name: "copper_nugget with sewage byproduct", targetId: "item_copper_nugget" as ItemId, rate: 6 },
  { name: "iron_nugget", targetId: "item_iron_nugget" as ItemId, rate: 10 },
  { name: "xiranite_poly", targetId: "item_xiranite_poly" as ItemId, rate: 5 },
];

describe("flow mapper integrity", () => {
  const plans = new Map<string, { plan: ProductionDependencyGraph; targetRates: Map<ItemId, number> }>();

  beforeAll(async () => {
    for (const c of cases) {
      const plan = await calculateProductionPlan(
        [{ itemId: c.targetId, rate: c.rate }],
        items,
        recipes,
        facilities,
      );
      plans.set(c.name, { plan, targetRates: new Map([[c.targetId, c.rate]]) });
    }
  });

  for (const c of cases) {
    test(`${c.name}: merged (legacy bf=0) has no dangling edges or isolated nodes`, async () => {
      const { plan, targetRates } = plans.get(c.name)!;
      const flow = mapPlanToFlowMerged(plan, items, facilities, targetRates);
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
    });

    test(`${c.name}: bin-fused Recipe View has no dangling edges or isolated nodes`, async () => {
      const { plan, targetRates } = plans.get(c.name)!;
      const flow = mapPlanToFlowBinFused(plan, items, recipes, facilities, targetRates);
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
    });

    test(`${c.name}: bin-fused Facility View has no dangling edges or isolated nodes`, async () => {
      const { plan, targetRates } = plans.get(c.name)!;
      const flow = mapPlanToFlowBinFusedSeparated(
        plan,
        items,
        recipes,
        facilities,
        targetRates,
      );
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
    });
  }
});

describe("Phase 3 bin-aware integrity", () => {
  test("xircon plan: every recipe node has a binId after Phase 3", async () => {
    // Phase 3 should annotate every active recipe in the plan with a
    // binId (singleton or grouped). Recipes lacking a binId would render
    // as if Phase 3 didn't run, which breaks downstream amortization
    // logic in the production table and node tooltips.
    const plan = await calculateProductionPlan(
      [{ itemId: "item_xiranite_poly" as ItemId, rate: 5 }],
      items,
      recipes,
      facilities,
    );
    for (const node of plan.nodes.values()) {
      if (node.type !== "recipe") continue;
      if (node.isDisposal) continue;
      if (node.facilityCount <= 1e-9) continue;
      expect(node.binId).toBeDefined();
    }
  });
});

describe("Prefill chip rendering across views", () => {
  // Pins both mapper paths to the same prefill payload. Flow nodes
  // wrap the data as `data.productionNode`, so this looks one level
  // deeper than the raw `Bin` / `ProductionGraphNode` carriers.
  //
  //   - bf=0 (`mapPlanToFlowMerged`): the chip is attached per recipe
  //     node, sourced from `ProductionGraphNode.prefillCandidates`.
  //   - bf=1 (`mapPlanToFlowBinFused`): the chip is attached per bin
  //     node, sourced from `bin.prefillCandidates` (the per-bin union).
  // Both paths populate `data.productionNode.prefillCandidates` so
  // `CustomProductionNode` reads `node.prefillCandidates` uniformly.
  type NodeData = {
    productionNode: { prefillCandidates?: ItemId[]; bin?: { prefillCandidates: ItemId[] } };
  };

  test("plant moss plan: planter recipe carries [seed] chip in bf=0", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: "item_plant_moss_powder_1" as ItemId, rate: 30 }],
      items,
      recipes,
      facilities,
    );
    const targetRates = new Map<ItemId, number>([
      ["item_plant_moss_powder_1" as ItemId, 30],
    ]);
    const flow = mapPlanToFlowMerged(plan, items, facilities, targetRates);

    const planterNode = flow.nodes.find(
      (n) => n.id === "planter_plant_moss_1_1",
    );
    expect(planterNode).toBeDefined();
    const planterData = planterNode!.data as NodeData;
    expect(planterData.productionNode.prefillCandidates).toEqual([
      "item_plant_moss_seed_1" as ItemId,
    ]);

    const seedcollectorNode = flow.nodes.find(
      (n) => n.id === "seedcollector_plant_moss_1_1",
    );
    expect(seedcollectorNode).toBeDefined();
    const seedcollectorData = seedcollectorNode!.data as NodeData;
    expect(seedcollectorData.productionNode.prefillCandidates).toEqual([
      "item_plant_moss_1" as ItemId,
    ]);

    // The Carbon-Powder Furnace consuming plant_moss_powder is acyclic
    // → no chip. Pins the negative case so a future bug that flags
    // every consumer of a cycle item gets caught immediately.
    const furnaceNode = flow.nodes.find(
      (n) => n.id === "furnance_carbon_powder_1_1",
    );
    if (furnaceNode) {
      const data = furnaceNode.data as NodeData;
      expect(data.productionNode.prefillCandidates ?? []).toEqual([]);
    }
  });

  test("plant moss plan: planter bin carries [seed] chip in bf=1", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: "item_plant_moss_powder_1" as ItemId, rate: 30 }],
      items,
      recipes,
      facilities,
    );
    const targetRates = new Map<ItemId, number>([
      ["item_plant_moss_powder_1" as ItemId, 30],
    ]);
    const flow = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      targetRates,
    );

    // Bin-fused IDs are bin ids, not recipe ids. Locate by the recipe.
    const planterBin = plan.bins.find(
      (b) => b.recipeIds[0] === "planter_plant_moss_1_1",
    );
    expect(planterBin).toBeDefined();
    const planterNode = flow.nodes.find((n) => n.id === planterBin!.id);
    expect(planterNode).toBeDefined();
    const data = planterNode!.data as NodeData;
    // Both surfaces carry the same data — bf=1 mapper uses the bin's
    // union, which for a singleton bin equals the lone recipe's list.
    expect(data.productionNode.prefillCandidates).toEqual([
      "item_plant_moss_seed_1" as ItemId,
    ]);
    expect(data.productionNode.bin?.prefillCandidates).toEqual([
      "item_plant_moss_seed_1" as ItemId,
    ]);
  });

  test("Xircon-60: 3-formula bin flags [Sewage] in bf=1; 2-formula bin clean; bf=0 follows recipe union", async () => {
    // Intra-bin filter: 3-formula Crucible bin (LX-Prod + Effluent-Prod
    // + Xircon-Prod) has Sewage as INTERNAL (Xircon-Prod produces,
    // Effluent-Prod consumes; balanced). No external Sewage port →
    // chip emitted. The 2-formula bin has Sewage as externalInput
    // (Furnace ships 36/min) → no chip.
    //
    // bf=0 union: Effluent-Prod is in BOTH bins; the per-recipe union
    // carries [Sewage] (because Bin 0 needs it). Xircon-Prod is only
    // in Bin 0 and its cycle-consumed item (Effluent) IS externally
    // imported → its per-recipe list stays empty.
    const plan = await calculateProductionPlan(
      [{ itemId: "item_xiranite_poly" as ItemId, rate: 60 }],
      items,
      recipes,
      facilities,
    );
    const targetRates = new Map<ItemId, number>([
      ["item_xiranite_poly" as ItemId, 60],
    ]);

    const bin3f = plan.bins.find(
      (b) =>
        b.facilityId === ("mix_pool_2" as FacilityId) &&
        b.recipeIds.includes("pool_xiranite_poly_1" as never),
    );
    const bin2f = plan.bins.find(
      (b) =>
        b.facilityId === ("mix_pool_2" as FacilityId) &&
        !b.recipeIds.includes("pool_xiranite_poly_1" as never),
    );
    expect(bin3f).toBeDefined();
    expect(bin2f).toBeDefined();
    expect(bin3f!.prefillCandidates).toEqual([
      "item_liquid_sewage" as ItemId,
    ]);
    expect(bin2f!.prefillCandidates).toEqual([]);

    // bf=1: each bin node carries its bin's chip.
    const binFused = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      targetRates,
    );
    const bin3fNode = binFused.nodes.find((n) => n.id === bin3f!.id);
    const bin2fNode = binFused.nodes.find((n) => n.id === bin2f!.id);
    if (bin3fNode) {
      const data = bin3fNode.data as NodeData;
      expect(data.productionNode.prefillCandidates).toEqual([
        "item_liquid_sewage" as ItemId,
      ]);
      expect(data.productionNode.bin?.prefillCandidates).toEqual([
        "item_liquid_sewage" as ItemId,
      ]);
    }
    if (bin2fNode) {
      const data = bin2fNode.data as NodeData;
      expect(data.productionNode.prefillCandidates ?? []).toEqual([]);
      expect(data.productionNode.bin?.prefillCandidates ?? []).toEqual([]);
    }

    // bf=0: per-recipe nodes carry the recipe-level union across all
    // hosting bins.
    const merged = mapPlanToFlowMerged(plan, items, facilities, targetRates);
    const effluentNode = merged.nodes.find(
      (n) => n.id === "pool_liquid_xiranite_poly_1",
    );
    if (effluentNode) {
      const data = effluentNode.data as NodeData;
      expect(data.productionNode.prefillCandidates).toEqual([
        "item_liquid_sewage" as ItemId,
      ]);
    }
    const xirconNode = merged.nodes.find(
      (n) => n.id === "pool_xiranite_poly_1",
    );
    if (xirconNode) {
      const data = xirconNode.data as NodeData;
      expect(data.productionNode.prefillCandidates ?? []).toEqual([]);
    }
    const lxNode = merged.nodes.find(
      (n) => n.id === "pool_liquid_liquid_xiranite_1",
    );
    if (lxNode) {
      const data = lxNode.data as NodeData;
      expect(data.productionNode.prefillCandidates ?? []).toEqual([]);
    }
  });
});
