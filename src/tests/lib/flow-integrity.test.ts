import { describe, test, expect, beforeAll } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import { mapPlanToFlowMerged } from "@/components/mappers/merged-mapper";
import { mapPlanToFlowSeparated } from "@/components/mappers/separated-mapper";
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
    test(`${c.name}: merged has no dangling edges or isolated nodes`, () => {
      const { plan, targetRates } = plans.get(c.name)!;
      const flow = mapPlanToFlowMerged(plan, items, facilities, targetRates);
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
    });

    test(`${c.name}: separated has no dangling edges or isolated nodes`, () => {
      const { plan, targetRates } = plans.get(c.name)!;
      const flow = mapPlanToFlowSeparated(plan, items, facilities, targetRates);
      const { dangling, isolated } = checkIntegrity(flow.nodes, flow.edges);
      expect(dangling).toEqual([]);
      expect(isolated).toEqual([]);
    });
  }
});
