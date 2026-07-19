/**
 * Drift guard + invariants for the generated `src/data/target-gates.ts`.
 *
 * The committed map is emitted by `scripts/extract-target-gates.ts` from
 * `computeTargetGates`. CI can't run the extractors, so this test
 * recomputes via the same pure function and asserts the committed file
 * still matches — catching the case where an upstream data file changed
 * without a `bun run extract:target-gates`.
 */
import { describe, test, expect } from "vitest";

import { computeTargetGates } from "@/lib/target-gate-helpers";
import { targetGates } from "@/data/target-gates";
import { aicNodes, domains } from "@/data/aic-plans";
import { items, recipes } from "@/data";
import type { TargetGate } from "@/types/target-gates";
import type { AicTechId } from "@/types/aic";
import type { ItemId } from "@/types";

/** Order-independent canonical form for deep comparison. */
function canonical(gates: ReadonlyMap<ItemId, TargetGate>): string {
  const entries = [...gates.keys()].sort().map((id) => {
    const gate = gates.get(id)!;
    const factories = [...gate.factories]
      .sort((a, b) => a.factoryDomainId.localeCompare(b.factoryDomainId))
      .map((f) => ({
        factory: f.factoryDomainId,
        regions: [...f.planRegions]
          .sort((a, b) => a.domainId.localeCompare(b.domainId))
          .map((pr) => ({ d: pr.domainId, t: [...pr.techIds].sort() })),
      }));
    return [id, factories];
  });
  return JSON.stringify(entries);
}

describe("target-gates — drift guard", () => {
  test("committed src/data/target-gates.ts matches computeTargetGates()", () => {
    const { gates, warnings } = computeTargetGates();
    expect(warnings).toEqual([]);
    expect(canonical(targetGates)).toBe(canonical(gates));
  });
});

describe("target-gates — invariants", () => {
  const nodeById = new Map(aicNodes.map((n) => [n.id, n]));
  const validDomainIds = new Set(domains.map((d) => d.id));
  const sortId = new Map(domains.map((d) => [d.id, d.sortId]));
  const targetableItemIds = new Set(
    items.filter((i) => i.asTarget !== false).map((i) => i.id),
  );
  const producedItemIds = new Set<ItemId>();
  for (const r of recipes) for (const o of r.outputs) producedItemIds.add(o.itemId);

  test("every gated item is a producible, targetable item", () => {
    for (const itemId of targetGates.keys()) {
      expect(targetableItemIds.has(itemId)).toBe(true);
      expect(producedItemIds.has(itemId)).toBe(true);
    }
  });

  test("every tech exists, is not always-unlocked, and lives in its plan region", () => {
    for (const gate of targetGates.values()) {
      for (const factory of gate.factories) {
        for (const region of factory.planRegions) {
          expect(validDomainIds.has(region.domainId)).toBe(true);
          expect(region.techIds.length).toBeGreaterThan(0);
          for (const techId of region.techIds) {
            const node = nodeById.get(techId as AicTechId);
            expect(node, `${techId} must be a real AIC node`).toBeDefined();
            expect(node!.alreadyUnlocked).toBe(false);
          }
        }
      }
    }
  });

  test("factories and plan regions are ordered earliest-first by sortId", () => {
    for (const gate of targetGates.values()) {
      const factoryOrder = gate.factories.map(
        (f) => sortId.get(f.factoryDomainId)!,
      );
      expect(factoryOrder).toEqual([...factoryOrder].sort((a, b) => a - b));
      for (const factory of gate.factories) {
        const regionOrder = factory.planRegions.map(
          (pr) => sortId.get(pr.domainId)!,
        );
        expect(regionOrder).toEqual([...regionOrder].sort((a, b) => a - b));
      }
    }
  });

  test("no factory entry is empty", () => {
    for (const gate of targetGates.values()) {
      expect(gate.factories.length).toBeGreaterThan(0);
    }
  });
});
