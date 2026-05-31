import { describe, expect, test } from "vitest";

import {
  countAicResearched,
  countCustomizedCaps,
  countRawSourced,
  filterRegionRawItems,
  resolveEditingDomain,
} from "@/lib/settings-helpers";
import { rawLimitKey } from "@/lib/raw-limits-helpers";
import { AicGroupId } from "@/types/aic";
import type { AicGroup, AicNode, AicLayerId, AicTechId } from "@/types/aic";
import { FacilityId } from "@/types/constants";
import type { Item, ItemId } from "@/types";
import type { DomainId } from "@/types/domain";

const DOMAIN_1 = "domain_1" as DomainId;
const DOMAIN_2 = "domain_2" as DomainId;

describe("resolveEditingDomain", () => {
  test("keeps the requested region when still active", () => {
    const active = new Set<DomainId>([DOMAIN_1, DOMAIN_2]);
    expect(resolveEditingDomain(DOMAIN_2, active, DOMAIN_1)).toBe(DOMAIN_2);
  });

  test("falls back to currentDomain when the edited region is deactivated", () => {
    const active = new Set<DomainId>([DOMAIN_1]);
    expect(resolveEditingDomain(DOMAIN_2, active, DOMAIN_1)).toBe(DOMAIN_1);
  });

  test("currentDomain itself is always a valid target (hook invariant)", () => {
    const active = new Set<DomainId>([DOMAIN_1]);
    expect(resolveEditingDomain(DOMAIN_1, active, DOMAIN_1)).toBe(DOMAIN_1);
  });
});

// ── AIC plan fixtures ──────────────────────────────────────────────
// Two groups (one per region). Domain_1 has two researchable plan nodes
// (one researched) plus one cap-raise (must NOT be counted). Domain_2
// has a single researched plan node.
const groups: AicGroup[] = [
  { id: AicGroupId.BASIC, domainId: DOMAIN_1 },
  { id: AicGroupId.WULING, domainId: DOMAIN_2 },
];

const mkNode = (
  id: string,
  groupId: typeof AicGroupId.BASIC | typeof AicGroupId.WULING,
  action: AicNode["action"],
): AicNode => ({
  id: id as AicTechId,
  groupId,
  layerId: "L1" as AicLayerId,
  preNodes: [],
  alreadyUnlocked: false,
  action,
  additionalFacilities: [],
});

const nodes: AicNode[] = [
  mkNode("d1_plan_a", AicGroupId.BASIC, {
    kind: "unlock",
    facilityId: FacilityId.FURNANCE_1,
  }),
  mkNode("d1_plan_b", AicGroupId.BASIC, {
    kind: "unlock",
    facilityId: FacilityId.GRINDER_1,
  }),
  mkNode("d1_capraise", AicGroupId.BASIC, {
    kind: "capRaise",
    facilityId: FacilityId.FURNANCE_1,
    domainId: DOMAIN_1,
    delta: 4,
  }),
  mkNode("d2_plan_a", AicGroupId.WULING, {
    kind: "unlock",
    facilityId: FacilityId.SHAPER_1,
  }),
];

describe("countAicResearched", () => {
  test("counts only non-capRaise nodes in the region's groups", () => {
    const researched = new Set<AicTechId>(["d1_plan_a" as AicTechId]);
    // 2 researchable plan nodes in domain_1, 1 researched; cap-raise excluded.
    expect(countAicResearched(nodes, groups, researched, DOMAIN_1)).toEqual({
      done: 1,
      total: 2,
    });
  });

  test("scopes to the requested region", () => {
    const researched = new Set<AicTechId>(["d2_plan_a" as AicTechId]);
    expect(countAicResearched(nodes, groups, researched, DOMAIN_2)).toEqual({
      done: 1,
      total: 1,
    });
  });

  test("a fully-unresearched region reports done 0", () => {
    const researched = new Set<AicTechId>();
    expect(countAicResearched(nodes, groups, researched, DOMAIN_1)).toEqual({
      done: 0,
      total: 2,
    });
  });
});

describe("countCustomizedCaps", () => {
  const overrides = new Map<string, number>([
    [`${FacilityId.FURNANCE_1}\u0000${DOMAIN_1}`, 6],
    [`${FacilityId.GRINDER_1}\u0000${DOMAIN_1}`, 3],
    [`${FacilityId.SHAPER_1}\u0000${DOMAIN_2}`, 9],
  ]);

  test("counts overrides whose key targets the region", () => {
    expect(countCustomizedCaps(overrides, DOMAIN_1)).toBe(2);
    expect(countCustomizedCaps(overrides, DOMAIN_2)).toBe(1);
  });

  test("returns 0 for a region with no overrides", () => {
    expect(countCustomizedCaps(new Map(), DOMAIN_1)).toBe(0);
  });
});

// ── Raw-material fixtures ──────────────────────────────────────────
const ORE = "item_iron_ore" as ItemId;
const SAND = "item_quartz_sand" as ItemId;
const WATER = "item_water" as ItemId;
const UNKNOWN = "item_not_in_registry" as ItemId;

const itemsById = new Map<ItemId, Item>([
  [ORE, { id: ORE, tier: 0, isLiquid: false }],
  [SAND, { id: SAND, tier: 0 }],
  [WATER, { id: WATER, tier: 0, isLiquid: true }],
]);

describe("filterRegionRawItems", () => {
  test("drops liquids and ids absent from the registry", () => {
    const region = new Set<ItemId>([ORE, SAND, WATER, UNKNOWN]);
    const result = filterRegionRawItems(region, itemsById);
    const ids = result.map((i) => i.id);
    expect(ids).toContain(ORE);
    expect(ids).toContain(SAND);
    expect(ids).not.toContain(WATER); // liquid
    expect(ids).not.toContain(UNKNOWN); // not in registry
    expect(result).toHaveLength(2);
  });
});

describe("countRawSourced", () => {
  const rowItems: Item[] = [
    { id: ORE, tier: 0 },
    { id: SAND, tier: 0 },
  ];

  test("counts rows with an override for this region only", () => {
    const overrides = new Map<string, number>([
      [rawLimitKey(ORE, DOMAIN_1), 30],
      // Sand override belongs to a different region — must not count here.
      [rawLimitKey(SAND, DOMAIN_2), 10],
    ]);
    expect(countRawSourced(rowItems, overrides, DOMAIN_1)).toEqual({
      done: 1,
      total: 2,
    });
  });

  test("total reflects row count, done 0 when nothing sourced", () => {
    expect(countRawSourced(rowItems, new Map(), DOMAIN_1)).toEqual({
      done: 0,
      total: 2,
    });
  });
});
