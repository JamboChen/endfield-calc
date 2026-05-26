import { describe, test, expect, beforeAll } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { mapPlanToFlowMerged } from "@/components/mappers/merged-mapper";
import {
  mapPlanToFlowBinFused,
  mapPlanToFlowBinFusedSeparated,
} from "@/components/mappers/bin-fused-mapper";
import { items, recipes, facilities, rawMaterialSources} from "@/data";
import type { FacilityId, ItemId, ProductionDependencyGraph } from "@/types";
import type { Edge, Node } from "@xyflow/react";

// Test-only raw-material set: all items the canonical source-facility
// map knows about. Equivalent to the old global `forcedRawMaterials`
// (now removed); used as a default for tests that don't care about
// region-specific availability.
const ALL_RAWS: ReadonlySet<ItemId> = new Set(rawMaterialSources.keys());

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
      
        { rawMaterials: ALL_RAWS },
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
    
      { rawMaterials: ALL_RAWS },
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
    
      { rawMaterials: ALL_RAWS },
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
    
      { rawMaterials: ALL_RAWS },
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

  test("Xircon-60: both Crucible bins emit no chip in either view (cycle bootstraps via Xircon Effluent)", async () => {
    // The 3-formula Crucible bin's intra-bin (Effluent-Prod, Xircon-Prod)
    // cycle has external entry via Xircon Effluent (in externalInputs).
    // Phase 1 (intra-bin Tarjan) skips. The 2-formula bin's Sewage is
    // externalInput from Furnace; the inter-bin (Effluent-Prod,
    // Xircon-Prod) pair is silenced by Phase 2's bootability filter
    // because Sewage is bootable via Furnace. Both bins → []. bf=0
    // and bf=1 must agree.
    const plan = await calculateProductionPlan(
      [{ itemId: "item_xiranite_poly" as ItemId, rate: 60 }],
      items,
      recipes,
      facilities,
    
      { rawMaterials: ALL_RAWS },
    );
    const targetRates = new Map<ItemId, number>([
      ["item_xiranite_poly" as ItemId, 60],
    ]);

    const crucibleBins = plan.bins.filter(
      (b) => b.facilityId === ("mix_pool_2" as FacilityId),
    );
    expect(crucibleBins.length).toBeGreaterThan(0);
    for (const bin of crucibleBins) {
      expect(bin.prefillCandidates).toEqual([]);
    }

    // bf=1: each bin node carries its bin's chip (empty here).
    const binFused = mapPlanToFlowBinFused(
      plan,
      items,
      recipes,
      facilities,
      targetRates,
    );
    for (const bin of crucibleBins) {
      const node = binFused.nodes.find((n) => n.id === bin.id);
      if (!node) continue;
      const data = node.data as NodeData;
      expect(data.productionNode.prefillCandidates ?? []).toEqual([]);
      expect(data.productionNode.bin?.prefillCandidates ?? []).toEqual([]);
    }

    // bf=0: per-recipe nodes for the three pool recipes all empty.
    const merged = mapPlanToFlowMerged(plan, items, facilities, targetRates);
    for (const rid of [
      "pool_liquid_xiranite_poly_1",
      "pool_xiranite_poly_1",
      "pool_liquid_liquid_xiranite_1",
    ]) {
      const node = merged.nodes.find((n) => n.id === rid);
      if (!node) continue;
      const data = node.data as NodeData;
      expect(data.productionNode.prefillCandidates ?? []).toEqual([]);
    }
  });
});
