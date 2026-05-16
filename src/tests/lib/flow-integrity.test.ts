import { describe, test, expect, beforeAll } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { mapPlanToFlowMerged } from "@/components/mappers/merged-mapper";
import {
  mapPlanToFlowBinFused,
  mapPlanToFlowBinFusedSeparated,
} from "@/components/mappers/bin-fused-mapper";
import { items, recipes, facilities } from "@/data";
import type { ItemId, ProductionDependencyGraph } from "@/types";
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

  beforeAll(() => {
    for (const c of cases) {
      const plan = calculateProductionPlan(
        [{ itemId: c.targetId, rate: c.rate }],
        items,
        recipes,
        facilities,
      );
      plans.set(c.name, { plan, targetRates: new Map([[c.targetId, c.rate]]) });
    }
  });

  for (const c of cases) {
    test(`${c.name}: merged (legacy bf=0) has no dangling edges or isolated nodes`, () => {
      const { plan, targetRates } = plans.get(c.name)!;
      const flow = mapPlanToFlowMerged(plan, items, facilities, targetRates);
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
    });

    test(`${c.name}: bin-fused Recipe View has no dangling edges or isolated nodes`, () => {
      const { plan, targetRates } = plans.get(c.name)!;
      const flow = mapPlanToFlowBinFused(plan, items, recipes, facilities, targetRates);
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
    });

    test(`${c.name}: bin-fused Facility View has no dangling edges or isolated nodes`, () => {
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
  test("xircon plan: every recipe node has a binId after Phase 3", () => {
    // Phase 3 should annotate every active recipe in the plan with a
    // binId (singleton or grouped). Recipes lacking a binId would render
    // as if Phase 3 didn't run, which breaks downstream amortization
    // logic in the production table and node tooltips.
    const plan = calculateProductionPlan(
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
