/**
 * Invariants for the runtime target-gate derivation
 * (`computeTargetGatesForRegion`).
 *
 * The gate map is derived per factory region at runtime (no committed
 * generated file), so there is no drift guard to maintain. These tests
 * pin the structural guarantees the App layer and `resolveGateAction`
 * rely on, checked across every factory region.
 */
import { describe, test, expect } from "vitest";

import { computeTargetGatesForRegion } from "@/lib/target-gate-helpers";
import { aicNodes, domains } from "@/data/aic-plans";
import { items, recipes } from "@/data";
import type { AicTechId } from "@/types/aic";
import type { ItemId } from "@/types";

describe("target-gate derivation — invariants", () => {
  const nodeById = new Map(aicNodes.map((n) => [n.id, n]));
  const validDomainIds = new Set(domains.map((d) => d.id));
  const sortId = new Map(domains.map((d) => [d.id, d.sortId]));
  const pinnedDomainIds = new Set(
    domains.filter((d) => d.isPinned).map((d) => d.id),
  );
  const targetableItemIds = new Set(
    items.filter((i) => i.asTarget !== false).map((i) => i.id),
  );
  const producedItemIds = new Set<ItemId>();
  for (const r of recipes) for (const o of r.outputs) producedItemIds.add(o.itemId);

  // Derive once per factory region; reused across the assertions below.
  const perRegion = domains.map((d) => ({
    domain: d.id,
    gates: computeTargetGatesForRegion(d.id),
  }));

  test("the derivation is wired: at least one region yields gates", () => {
    expect(perRegion.some(({ gates }) => gates.size > 0)).toBe(true);
  });

  test("every gated item is a producible, targetable item", () => {
    for (const { gates } of perRegion) {
      for (const itemId of gates.keys()) {
        expect(targetableItemIds.has(itemId)).toBe(true);
        expect(producedItemIds.has(itemId)).toBe(true);
      }
    }
  });

  test("each gate carries exactly one factory entry, keyed to its region", () => {
    for (const { domain, gates } of perRegion) {
      for (const gate of gates.values()) {
        expect(gate.factories.length).toBe(1);
        expect(gate.factories[0].factoryDomainId).toBe(domain);
      }
    }
  });

  test("every tech exists, is not always-unlocked, and lives in a valid region", () => {
    for (const { gates } of perRegion) {
      for (const gate of gates.values()) {
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
    }
  });

  test("plan regions are ordered earliest-first by sortId", () => {
    for (const { gates } of perRegion) {
      for (const gate of gates.values()) {
        for (const factory of gate.factories) {
          const order = factory.planRegions.map((pr) => sortId.get(pr.domainId)!);
          expect(order).toEqual([...order].sort((a, b) => a - b));
        }
      }
    }
  });

  test("no gate needs a plan region that is neither pinned nor the factory region", () => {
    // A required plan region that is neither the always-active pinned home
    // region nor the factory region itself could be inactive at runtime,
    // making the item silently unresolvable (`resolveGateAction` returns
    // null). This replaces the old build-time `warnings === []` guard: it
    // holds for today's data and flags any future data change that breaks
    // the assumption.
    for (const { domain, gates } of perRegion) {
      for (const gate of gates.values()) {
        for (const factory of gate.factories) {
          for (const region of factory.planRegions) {
            expect(
              pinnedDomainIds.has(region.domainId) ||
                region.domainId === domain,
            ).toBe(true);
          }
        }
      }
    }
  });
});
