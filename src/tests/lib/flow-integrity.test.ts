import { describe, test, expect, beforeAll } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { mapPlanToFlowMerged } from "@/components/mappers/merged-mapper";
import {
  mapPlanToFlowBinFused,
  mapPlanToFlowBinFusedSeparated,
} from "@/components/mappers/bin-fused-mapper";
import {
  items,
  recipes,
  facilities,
  metastorageExports,
  metastorageSources,
  rawAvailabilityByDomain,
} from "@/data";
import { createMetastorageSourceId } from "@/lib/node-keys";
import { filterPlanForDisplay } from "@/lib/plan-helpers";
import { getTransportCount } from "@/lib/utils";
import type {
  FacilityId,
  ItemId,
  ProductionDependencyGraph,
  Recipe,
  RecipeId,
} from "@/types";
import type { MetastorageRouteConfig } from "@/types/metastorage";
import { DomainId } from "@/types/constants";
import type { Edge, Node } from "@xyflow/react";
import { ALL_RAWS } from "./utils";

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

describe("metastorage import flow integrity", () => {
  // Wuling plans fed by the real Valley IV route. Two shapes:
  //   - Dense Originium Powder 30/min — MIXED supply (import 25/min at
  //     the TTV cap + 5/min local thickener chain), so the import
  //     source coexists with recipe producers.
  //   - Quartz Glass 20/min — IMPORT-ONLY (Wuling has no quartz sand),
  //     so the entire flow graph is one import source + the target sink.
  const wulingRaws = rawAvailabilityByDomain.get(DomainId.DOMAIN_2)!;
  const valleyInfo = metastorageSources.get(DomainId.DOMAIN_1)!;
  const realRoute: MetastorageRouteConfig = {
    sourceDomain: DomainId.DOMAIN_1,
    ttvBudgetPerMinute:
      valleyInfo.ttvCapPerCycle / (valleyInfo.cycleSeconds / 60),
    cycleSeconds: valleyInfo.cycleSeconds,
    itemCosts: metastorageExports.get(DomainId.DOMAIN_1)!,
  };

  const importCases: { name: string; targetId: ItemId; rate: number }[] = [
    {
      name: "dense originium powder (mixed import + local)",
      targetId: "item_originium_enr_powder" as ItemId,
      rate: 30,
    },
    {
      name: "quartz glass (import-only)",
      targetId: "item_quartz_glass" as ItemId,
      rate: 20,
    },
  ];

  const importPlans = new Map<
    string,
    { plan: ProductionDependencyGraph; targetRates: Map<ItemId, number> }
  >();

  beforeAll(async () => {
    for (const c of importCases) {
      const plan = await calculateProductionPlan(
        [{ itemId: c.targetId, rate: c.rate }],
        items,
        recipes,
        facilities,
        { rawMaterials: wulingRaws, metastorageRoutes: [realRoute] },
      );
      importPlans.set(c.name, {
        plan,
        targetRates: new Map([[c.targetId, c.rate]]),
      });
    }
  });

  for (const c of importCases) {
    test(`${c.name}: all three mappers stay integrity-clean and emit the import source`, () => {
      const { plan, targetRates } = importPlans.get(c.name)!;
      expect(plan.metastorageImports.length).toBeGreaterThan(0);
      const importNodeIds = new Set(
        plan.metastorageImports.map((imp) =>
          createMetastorageSourceId(imp.sourceDomain, imp.itemId),
        ),
      );

      const flows = [
        mapPlanToFlowMerged(plan, items, facilities, targetRates),
        mapPlanToFlowBinFused(plan, items, recipes, facilities, targetRates),
        mapPlanToFlowBinFusedSeparated(
          plan,
          items,
          recipes,
          facilities,
          targetRates,
        ),
      ];
      for (const flow of flows) {
        const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
        expect(dangling).toEqual([]);
        expect(isolated).toEqual([]);
        // Every plan-level import surfaces as a source node with at
        // least one outgoing edge carrying the imported item.
        for (const importNodeId of importNodeIds) {
          const node = flow.nodes.find((n) => n.id === importNodeId);
          expect(node, `${importNodeId} node missing`).toBeDefined();
          const outEdges = flow.edges.filter((e) => e.source === importNodeId);
          expect(outEdges.length).toBeGreaterThan(0);
          const total = outEdges.reduce(
            (sum, e) => sum + ((e.data as { flowRate: number }).flowRate ?? 0),
            0,
          );
          const imp = plan.metastorageImports.find(
            (i) => createMetastorageSourceId(i.sourceDomain, i.itemId) === importNodeId,
          )!;
          expect(total).toBeCloseTo(imp.ratePerMinute, 2);
        }
      }
    });
  }

  test("synthetic mixed-supply intermediate keeps integrity in every view", async () => {
    // Iron nugget supplied by furnace (5/min) + import (25/min), both
    // feeding the grinder — the import source must split-merge cleanly
    // with the recipe producer in all three mappers.
    const { mockItems, mockFacilities, simpleRecipes } = await import(
      "./fixtures/test-data"
    );
    const plan = await calculateProductionPlan(
      [{ itemId: "item_iron_powder" as ItemId, rate: 30 }],
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
            itemCosts: new Map([["item_iron_nugget" as ItemId, 1]]),
          },
        ],
      },
    );
    const targetRates = new Map<ItemId, number>([
      ["item_iron_powder" as ItemId, 30],
    ]);
    const flows = [
      mapPlanToFlowMerged(plan, mockItems, mockFacilities, targetRates),
      mapPlanToFlowBinFused(
        plan,
        mockItems,
        simpleRecipes,
        mockFacilities,
        targetRates,
      ),
      mapPlanToFlowBinFusedSeparated(
        plan,
        mockItems,
        simpleRecipes,
        mockFacilities,
        targetRates,
      ),
    ];
    const importNodeId = createMetastorageSourceId(DomainId.DOMAIN_1, "item_iron_nugget");
    for (const flow of flows) {
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
      const outEdges = flow.edges.filter((e) => e.source === importNodeId);
      const total = outEdges.reduce(
        (sum, e) => sum + ((e.data as { flowRate: number }).flowRate ?? 0),
        0,
      );
      expect(total).toBeCloseTo(25, 2);
    }
  });

  test("import-only intermediate survives display filtering in every view", async () => {
    // Regression for the `displayPlan` zero-rate filter bug: a target
    // (battery) is produced locally from an intermediate (nugget) that
    // has NO local producer and is NOT itself importable — only the
    // intermediate is. The auto-selector imports the nugget, so its
    // LOCAL productionRate is 0. The mappers must run on the
    // display-FILTERED plan (as the hook does) and still surface the
    // import source + its edge; a naive zero-rate filter drops the
    // nugget node + edge silently (no integrity violation fires).
    const { mockItems, mockFacilities } = await import("./fixtures/test-data");
    const batteryFromNugget: Recipe[] = [
      {
        id: "tools_battery_from_nugget" as RecipeId,
        inputs: [{ itemId: "item_iron_nugget" as ItemId, amount: 1 }],
        outputs: [{ itemId: "item_proc_battery_1" as ItemId, amount: 1 }],
        facilityId: "tools_assebling_mc_1" as FacilityId,
        craftingTime: 2,
      },
    ];
    const rawPlan = await calculateProductionPlan(
      [{ itemId: "item_proc_battery_1" as ItemId, rate: 20 }],
      mockItems,
      batteryFromNugget,
      mockFacilities,
      {
        // Empty raw set: nugget has no producer here, so it would
        // normally degrade to a raw — the route keeps it balanced.
        rawMaterials: new Set<ItemId>(),
        metastorageRoutes: [
          {
            sourceDomain: DomainId.DOMAIN_1,
            ttvBudgetPerMinute: 25,
            cycleSeconds: 3600,
            itemCosts: new Map([["item_iron_nugget" as ItemId, 1]]),
          },
        ],
      },
    );
    expect(rawPlan.metastorageImports).toHaveLength(1);
    expect(rawPlan.metastorageImports[0].itemId).toBe("item_iron_nugget");

    // Run mappers on the FILTERED plan, exactly as the hook does.
    const plan = filterPlanForDisplay(rawPlan);
    const targetRates = new Map<ItemId, number>([
      ["item_proc_battery_1" as ItemId, 20],
    ]);
    const importNodeId = createMetastorageSourceId(DomainId.DOMAIN_1, "item_iron_nugget");
    const flows = [
      mapPlanToFlowMerged(plan, mockItems, mockFacilities, targetRates),
      mapPlanToFlowBinFused(
        plan,
        mockItems,
        batteryFromNugget,
        mockFacilities,
        targetRates,
      ),
      mapPlanToFlowBinFusedSeparated(
        plan,
        mockItems,
        batteryFromNugget,
        mockFacilities,
        targetRates,
      ),
    ];
    for (const flow of flows) {
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
      const node = flow.nodes.find((n) => n.id === importNodeId);
      expect(node, "import source node missing after display filter").toBeDefined();
      const outTotal = flow.edges
        .filter((e) => e.source === importNodeId)
        .reduce((s, e) => s + ((e.data as { flowRate: number }).flowRate ?? 0), 0);
      expect(outTotal).toBeCloseTo(20, 2);
    }
  });

  test("two sources importing the same item render as distinct nodes", async () => {
    // A region may receive the same item from multiple source regions.
    // Both must survive as separate producer nodes (keyed per source);
    // a by-item collapse would silently drop one source's supply.
    // ore→nugget→powder; both routes import nugget (cost 1, 25/min cap
    // each) → 50/min imported + 10/min local for a 60/min powder target.
    const { mockItems, mockFacilities, simpleRecipes } = await import(
      "./fixtures/test-data"
    );
    const plan = await calculateProductionPlan(
      [{ itemId: "item_iron_powder" as ItemId, rate: 60 }],
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
            itemCosts: new Map([["item_iron_nugget" as ItemId, 1]]),
          },
          {
            sourceDomain: DomainId.DOMAIN_2,
            ttvBudgetPerMinute: 25,
            cycleSeconds: 3600,
            itemCosts: new Map([["item_iron_nugget" as ItemId, 1]]),
          },
        ],
      },
    );
    // Both routes selected the same item from distinct sources.
    expect(plan.metastorageImports).toHaveLength(2);
    expect(new Set(plan.metastorageImports.map((i) => i.sourceDomain)).size).toBe(2);
    expect(
      plan.metastorageImports.every((i) => i.itemId === "item_iron_nugget"),
    ).toBe(true);

    const targetRates = new Map<ItemId, number>([
      ["item_iron_powder" as ItemId, 60],
    ]);
    const id1 = createMetastorageSourceId(DomainId.DOMAIN_1, "item_iron_nugget");
    const id2 = createMetastorageSourceId(DomainId.DOMAIN_2, "item_iron_nugget");
    const flows = [
      mapPlanToFlowMerged(plan, mockItems, mockFacilities, targetRates),
      mapPlanToFlowBinFused(plan, mockItems, simpleRecipes, mockFacilities, targetRates),
      mapPlanToFlowBinFusedSeparated(plan, mockItems, simpleRecipes, mockFacilities, targetRates),
    ];
    for (const flow of flows) {
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
      // Two distinct import nodes, neither collapsed onto the other.
      expect(flow.nodes.find((n) => n.id === id1)).toBeDefined();
      expect(flow.nodes.find((n) => n.id === id2)).toBeDefined();
      const total = flow.edges
        .filter((e) => e.source === id1 || e.source === id2)
        .reduce((s, e) => s + ((e.data as { flowRate: number }).flowRate ?? 0), 0);
      expect(total).toBeCloseTo(50, 2);
    }
  });
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

describe("belt-minimizing producer→consumer decomposition (issue #91)", () => {
  // Repro: Hetonite Component @ 6/min, Facility View. The old greedy
  // drained the largest Xiranite producer building first for every
  // consumer, splitting one 30/min producer across two consumers — an
  // extra edge and an extra belt vs. whole-producer pairing. The fix
  // (`computeTransportAllocation`) assigns whole producer buildings to
  // whole consumers: 5 full ovens + 1 partial oven feed two forges
  // (2 × 30 each), one mix pool (30), and one mix pool (18) over the
  // minimum 6 edges / 6 belts, with no producer split across consumers.
  test("hetonite component @ 6/min: xiranite powder uses whole-producer belts in Facility View", async () => {
    const targetId = "item_equip_script_4_2" as ItemId;
    const plan = await calculateProductionPlan(
      [{ itemId: targetId, rate: 6 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
    );
    const targetRates = new Map<ItemId, number>([[targetId, 6]]);
    const flow = mapPlanToFlowBinFusedSeparated(plan, items, recipes, facilities, targetRates);

    const xiraniteItem = items.find(
      (i) => i.id === ("item_xiranite_powder" as ItemId),
    );
    const xiraniteEdges = flow.edges.filter(
      (e) => e.sourceHandle === ("item_xiranite_powder" as ItemId),
    );

    // Whole-producer assignments: minimum edge count, no producer
    // building split across two consumers (old greedy: 7 edges, one
    // producer feeding both a mix pool and a forge).
    expect(xiraniteEdges).toHaveLength(6);
    const sources = xiraniteEdges.map((e) => e.source);
    expect(new Set(sources).size).toBe(sources.length);

    // Belt total: one belt per 30/min edge (fp noise in per-building
    // rates must not ceil a 30/min edge to 2 belts).
    const belts = xiraniteEdges.reduce(
      (sum, e) =>
        sum +
        getTransportCount(
          (e.data as { flowRate: number }).flowRate,
          xiraniteItem,
          true,
        ),
      0,
    );
    expect(belts).toBe(6);
  });

  // Follow-up repro: the raw-material pickup → consumer path was a
  // FOURTH greedy copy (sequential carving) that the original fix never
  // touched. With 60/min water pumps feeding 30/min consumers plus
  // partial-load 28.8/min ones, it daisy-chained 1.2 + 28.8 complement
  // edges across the whole pickup row (observed in this exact plan:
  // Clean Water #4 → 1.2 to one building + 28.8 to another, the latter
  // complemented by 1.2 from Clean Water #3, repeating).
  test("hetonite component @ 6/min: every water consumer drinks from exactly one pump", async () => {
    const targetId = "item_equip_script_4_2" as ItemId;
    const plan = await calculateProductionPlan(
      [{ itemId: targetId, rate: 6 }],
      items,
      recipes,
      facilities,
      { rawMaterials: ALL_RAWS },
    );
    const targetRates = new Map<ItemId, number>([[targetId, 6]]);
    const flow = mapPlanToFlowBinFusedSeparated(plan, items, recipes, facilities, targetRates);

    // Pickup-instance node ids: raw_item_liquid_water-p{i}.
    const waterPickupEdges = flow.edges.filter((e) =>
      e.source.startsWith("raw_item_liquid_water-p"),
    );
    expect(waterPickupEdges.length).toBeGreaterThan(0);

    const byConsumer = new Map<string, number[]>();
    for (const e of waterPickupEdges) {
      const rates = byConsumer.get(e.target) ?? [];
      rates.push((e.data as { flowRate: number }).flowRate);
      byConsumer.set(e.target, rates);
    }

    // Demand profile of this plan: 26 consumers × 30/min + 4 × 18/min
    // = 852/min → 15 pumps (14 × 60 + one 12 partial). The four 18s
    // total 72 = 60 + 12, and no whole 18 fits into the 12-partial, so
    // EXACTLY ONE consumer must draw from two pickups (12 + 6); every
    // other consumer gets a single pickup edge. The old carving instead
    // daisy-chained complement pairs across the whole row.
    expect(byConsumer.size).toBe(30);
    expect(waterPickupEdges).toHaveLength(31);
    const multiFed = [...byConsumer.entries()].filter(
      ([, rates]) => rates.length > 1,
    );
    expect(
      multiFed.map(([c, rates]) => `${c} <- ${rates.length} pumps`),
    ).toHaveLength(1);
    // The seam consumer's two edges still sum to its 18/min demand.
    expect(
      multiFed[0][1].reduce((a, b) => a + b, 0),
    ).toBeCloseTo(18, 3);
  });
});
