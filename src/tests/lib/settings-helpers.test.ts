import { describe, expect, test } from "vitest";

import {
  cascadeStructureChain,
  countAicResearched,
  countCustomizedCaps,
  countFacilityCapTargets,
  countRawSourced,
  countRegionStructuresEnabled,
  deriveStructuresEnabledFromDisabled,
  diffSettings,
  filterRegionRawItems,
  initialStructuresEnabled,
  resolveActiveTab,
  resolveEditingDomain,
  structureKey,
  structuresDisabledFromEnabled,
  type DiffableSettings,
} from "@/lib/settings-helpers";
import { rawLimitKey } from "@/lib/raw-limits-helpers";
import { AicGroupId } from "@/types/aic";
import type {
  AicGroup,
  AicNode,
  AicLayerId,
  AicTechId,
  FacilityBaseCap,
} from "@/types/aic";
import { FacilityId, ItemId, RegionStructureId } from "@/types/constants";
import type { Item } from "@/types";
import { DomainId } from "@/types/domain";
import type { RegionStructure } from "@/types/structures";

const DOMAIN_1 = DomainId.DOMAIN_1;
const DOMAIN_2 = DomainId.DOMAIN_2;

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

describe("countFacilityCapTargets", () => {
  const baseCaps: FacilityBaseCap[] = [
    { facilityId: FacilityId.FURNANCE_1, domainId: DOMAIN_2, base: 1 },
  ];
  const capRaise = (facilityId: FacilityId, domainId: DomainId): AicNode => ({
    id: `raise_${facilityId}` as AicTechId,
    groupId: AicGroupId.WULING,
    layerId: "L1" as AicLayerId,
    preNodes: [],
    alreadyUnlocked: false,
    action: { kind: "capRaise", facilityId, domainId, delta: 1 },
    additionalFacilities: [],
  });

  test("counts a facility with a base cap or a cap-raise (deduped)", () => {
    const nodes = [capRaise(FacilityId.FURNANCE_1, DOMAIN_2)];
    // Same facility via base + raise → 1 distinct target.
    expect(countFacilityCapTargets(baseCaps, nodes, DOMAIN_2)).toBe(1);
  });

  test("counts a cap-raise-only facility", () => {
    const nodes = [capRaise(FacilityId.GRINDER_1, DOMAIN_2)];
    expect(countFacilityCapTargets(baseCaps, nodes, DOMAIN_2)).toBe(2);
  });

  test("returns 0 for a region with no targets (drives tab hiding)", () => {
    expect(countFacilityCapTargets(baseCaps, [], DOMAIN_1)).toBe(0);
  });
});

// ── Region-structure chain fixtures (Wuling Purification Node) ──────
const mkStructure = (
  id: RegionStructureId,
  requires: RegionStructureId | undefined,
  index?: number,
): RegionStructure => ({
  id,
  domainId: DOMAIN_2,
  nodeId: "test_node_1",
  requires,
  index,
  iconSlug: `icon_${id}`,
  // Test fixtures use the inlet's facility id for the chain's "instance"
  // structures and the same id for the tail "recipeToggle" — the
  // cascade helpers don't read `solver`, only `requires`.
  solver:
    index === undefined
      ? { role: "recipeToggle", facilityId: FacilityId.LIQUID_CLEAN_GATE_1 }
      : { role: "instance", facilityId: FacilityId.LIQUID_CLEAN_GATE_1 },
});

const CHAIN: RegionStructure[] = [
  mkStructure(RegionStructureId.LIQUID_CLEAN_GATE_1, undefined, 1),
  mkStructure(RegionStructureId.LIQUID_CLEAN_GATE_2, RegionStructureId.LIQUID_CLEAN_GATE_1, 2),
  mkStructure(RegionStructureId.LIQUID_CLEAN_GATE_3, RegionStructureId.LIQUID_CLEAN_GATE_2, 3),
  mkStructure(RegionStructureId.LIQUID_RECYCLE_GATE_1, RegionStructureId.LIQUID_CLEAN_GATE_3),
];

describe("cascadeStructureChain", () => {
  test("enabling a structure pulls in its prereq chain", () => {
    const next = cascadeStructureChain(
      CHAIN,
      new Set(),
      RegionStructureId.LIQUID_CLEAN_GATE_3,
    );
    expect(next).toEqual(
      new Set([
        RegionStructureId.LIQUID_CLEAN_GATE_1,
        RegionStructureId.LIQUID_CLEAN_GATE_2,
        RegionStructureId.LIQUID_CLEAN_GATE_3,
      ]),
    );
  });

  test("enabling the tail (Byproduct Outlet) enables the whole chain", () => {
    const next = cascadeStructureChain(
      CHAIN,
      new Set(),
      RegionStructureId.LIQUID_RECYCLE_GATE_1,
    );
    expect(next.size).toBe(4);
  });

  test("disabling the head drops every dependent", () => {
    const all = new Set([
      RegionStructureId.LIQUID_CLEAN_GATE_1,
      RegionStructureId.LIQUID_CLEAN_GATE_2,
      RegionStructureId.LIQUID_CLEAN_GATE_3,
      RegionStructureId.LIQUID_RECYCLE_GATE_1,
    ]);
    const next = cascadeStructureChain(
      CHAIN,
      all,
      RegionStructureId.LIQUID_CLEAN_GATE_1,
    );
    expect(next.size).toBe(0);
  });

  test("disabling a middle link drops only its dependents", () => {
    const enabled = new Set([
      RegionStructureId.LIQUID_CLEAN_GATE_1,
      RegionStructureId.LIQUID_CLEAN_GATE_2,
      RegionStructureId.LIQUID_CLEAN_GATE_3,
    ]);
    const next = cascadeStructureChain(
      CHAIN,
      enabled,
      RegionStructureId.LIQUID_CLEAN_GATE_2,
    );
    expect(next).toEqual(new Set([RegionStructureId.LIQUID_CLEAN_GATE_1]));
  });

  test("enabling the head alone keeps it minimal", () => {
    const next = cascadeStructureChain(
      CHAIN,
      new Set(),
      RegionStructureId.LIQUID_CLEAN_GATE_1,
    );
    expect(next).toEqual(new Set([RegionStructureId.LIQUID_CLEAN_GATE_1]));
  });
});

describe("countRegionStructuresEnabled", () => {
  test("counts enabled structures for the region against the total", () => {
    const enabled = new Set<string>([
      structureKey(DOMAIN_2, RegionStructureId.LIQUID_CLEAN_GATE_1),
      structureKey(DOMAIN_2, RegionStructureId.LIQUID_CLEAN_GATE_2),
    ]);
    expect(countRegionStructuresEnabled(enabled, CHAIN, DOMAIN_2)).toEqual({
      done: 2,
      total: 4,
    });
  });

  test("ignores enabled keys from other regions", () => {
    const enabled = new Set<string>([
      structureKey(DOMAIN_1, RegionStructureId.LIQUID_CLEAN_GATE_1),
    ]);
    expect(countRegionStructuresEnabled(enabled, CHAIN, DOMAIN_2)).toEqual({
      done: 0,
      total: 4,
    });
  });
});

describe("structureKey", () => {
  test("encodes a NUL-delimited (domain, structure) pair", () => {
    expect(structureKey(DOMAIN_2, RegionStructureId.LIQUID_CLEAN_GATE_1)).toBe(
      "domain_2\u0000liquid_clean_gate_1",
    );
  });
});

describe("resolveActiveTab", () => {
  test("keeps the requested tab when available", () => {
    expect(resolveActiveTab("limits", ["plan", "limits", "raws"])).toBe(
      "limits",
    );
  });

  test("falls back to the first available tab when not present", () => {
    // e.g. on Wuling's Limits, then switch to a region without Limits.
    expect(resolveActiveTab("limits", ["plan", "raws"])).toBe("plan");
  });

  test("returns the request unchanged when nothing is available", () => {
    expect(resolveActiveTab("plan", [])).toBe("plan");
  });
});

// ── Structure persistence helpers ──────────────────────────────────
//
// Three pure helpers that together implement the default-active /
// inverted-persistence pattern for region structures, mirroring AIC's
// (`initialResearchedSet` → `deriveResearchedFromUnresearched`).
//
// `initialStructuresEnabled` is the round-trip identity with an
// empty `disabled` array; `structuresDisabledFromEnabled` and
// `deriveStructuresEnabledFromDisabled` are mutual inverses on the
// subset (registry × activeDomains).

const REGISTRY: ReadonlyMap<DomainId, readonly RegionStructure[]> = new Map([
  [DOMAIN_2, CHAIN],
]);

describe("initialStructuresEnabled", () => {
  test("enables every structure in every active domain", () => {
    const enabled = initialStructuresEnabled(
      REGISTRY,
      new Set([DOMAIN_2]),
    );
    expect(enabled.size).toBe(4);
    for (const s of CHAIN) {
      expect(enabled.has(structureKey(DOMAIN_2, s.id))).toBe(true);
    }
  });

  test("inactive domains contribute nothing", () => {
    const enabled = initialStructuresEnabled(
      REGISTRY,
      new Set([DOMAIN_1]), // Wuling NOT active
    );
    expect(enabled.size).toBe(0);
  });

  test("empty registry returns empty regardless of active set", () => {
    const enabled = initialStructuresEnabled(
      new Map(),
      new Set([DOMAIN_1, DOMAIN_2]),
    );
    expect(enabled.size).toBe(0);
  });
});

describe("deriveStructuresEnabledFromDisabled", () => {
  test("empty disabled list round-trips to initialStructuresEnabled", () => {
    const active = new Set([DOMAIN_2]);
    const fromDerive = deriveStructuresEnabledFromDisabled(
      [],
      REGISTRY,
      active,
    );
    const fromInitial = initialStructuresEnabled(REGISTRY, active);
    expect(fromDerive).toEqual(fromInitial);
  });

  test("one disabled entry excludes only that structure", () => {
    const enabled = deriveStructuresEnabledFromDisabled(
      [
        {
          domainId: DOMAIN_2,
          structureId: RegionStructureId.LIQUID_RECYCLE_GATE_1,
        },
      ],
      REGISTRY,
      new Set([DOMAIN_2]),
    );
    expect(enabled.size).toBe(3);
    expect(
      enabled.has(structureKey(DOMAIN_2, RegionStructureId.LIQUID_RECYCLE_GATE_1)),
    ).toBe(false);
    expect(
      enabled.has(structureKey(DOMAIN_2, RegionStructureId.LIQUID_CLEAN_GATE_1)),
    ).toBe(true);
  });

  test("disabled entry for an inactive domain is irrelevant", () => {
    // domain_1 isn't in the registry at all; the disabled entry should
    // be silently ignored without affecting domain_2's structures.
    const enabled = deriveStructuresEnabledFromDisabled(
      [
        {
          domainId: DOMAIN_1,
          structureId: RegionStructureId.LIQUID_CLEAN_GATE_1,
        },
      ],
      REGISTRY,
      new Set([DOMAIN_2]),
    );
    expect(enabled.size).toBe(4);
  });

  test("inactive domain's disabled list doesn't leak enabled entries", () => {
    // If Wuling is inactive, none of its structures should be enabled,
    // regardless of what's in the disabled list.
    const enabled = deriveStructuresEnabledFromDisabled(
      [],
      REGISTRY,
      new Set<DomainId>(), // no active domains
    );
    expect(enabled.size).toBe(0);
  });
});

describe("structuresDisabledFromEnabled", () => {
  test("computes the absence list as registry minus enabled", () => {
    const enabled = new Set<string>([
      structureKey(DOMAIN_2, RegionStructureId.LIQUID_CLEAN_GATE_1),
      structureKey(DOMAIN_2, RegionStructureId.LIQUID_CLEAN_GATE_2),
    ]);
    const disabled = structuresDisabledFromEnabled(
      enabled,
      REGISTRY,
      new Set([DOMAIN_2]),
    );
    expect(disabled).toHaveLength(2);
    const ids = disabled.map((d) => d.structureId).sort();
    expect(ids).toEqual(
      [
        RegionStructureId.LIQUID_CLEAN_GATE_3,
        RegionStructureId.LIQUID_RECYCLE_GATE_1,
      ].sort(),
    );
  });

  test("all-enabled set produces an empty disabled list", () => {
    const enabled = initialStructuresEnabled(REGISTRY, new Set([DOMAIN_2]));
    const disabled = structuresDisabledFromEnabled(
      enabled,
      REGISTRY,
      new Set([DOMAIN_2]),
    );
    expect(disabled).toEqual([]);
  });

  test("inverse of deriveStructuresEnabledFromDisabled on the active subset", () => {
    const originalDisabled = [
      {
        domainId: DOMAIN_2,
        structureId: RegionStructureId.LIQUID_RECYCLE_GATE_1,
      },
    ];
    const active = new Set([DOMAIN_2]);
    const enabled = deriveStructuresEnabledFromDisabled(
      originalDisabled,
      REGISTRY,
      active,
    );
    const roundTrip = structuresDisabledFromEnabled(
      enabled,
      REGISTRY,
      active,
    );
    expect(roundTrip).toEqual(originalDisabled);
  });
});

describe("diffSettings", () => {
  const DOMAIN_1 = DomainId.DOMAIN_1;
  const DOMAIN_2 = DomainId.DOMAIN_2;

  function make(over: Partial<DiffableSettings> = {}): DiffableSettings {
    return {
      inactiveDomains: new Set([DOMAIN_2]),
      researched: new Set<AicTechId>(),
      capOverrides: new Map<string, number>(),
      currentDomain: DOMAIN_1,
      rawLimitOverrides: new Map<string, number>(),
      structuresEnabled: new Set<string>(),
      metastorageRouteModes: new Map<DomainId, "disabled" | DomainId>(),
      ...over,
    };
  }

  test("identical settings produce an empty diff", () => {
    const d = diffSettings(make(), make());
    expect(d.currentDomainChanged).toBe(false);
    expect(d.domainActivation.size).toBe(0);
    expect(d.researched.size).toBe(0);
    expect(d.capOverrides.size).toBe(0);
    expect(d.rawLimits.size).toBe(0);
    expect(d.structures.size).toBe(0);
    expect(d.routes.size).toBe(0);
  });

  test("flags a changed current region", () => {
    const d = diffSettings(
      make({ inactiveDomains: new Set(), currentDomain: DOMAIN_2 }),
      make(),
    );
    expect(d.currentDomainChanged).toBe(true);
    expect(d.domainActivation.has(DOMAIN_2)).toBe(true);
  });

  test("researched diff is symmetric (either side)", () => {
    const a = "tech_a" as AicTechId;
    const b = "tech_b" as AicTechId;
    const d = diffSettings(
      make({ researched: new Set([a]) }),
      make({ researched: new Set([b]) }),
    );
    expect([...d.researched].sort()).toEqual([a, b].sort());
  });

  test("cap/raw overrides flag presence and value differences", () => {
    const d = diffSettings(
      make({
        capOverrides: new Map([["k1", 5]]),
        rawLimitOverrides: new Map([["r1", 30]]),
      }),
      make({
        // k1 only on the shared side (presence); r1 differs in value.
        rawLimitOverrides: new Map([["r1", 60]]),
      }),
    );
    expect(d.capOverrides.has("k1")).toBe(true);
    expect(d.rawLimits.has("r1")).toBe(true);
  });

  test("structures and metastorage routes are flagged", () => {
    const sk = structureKey(DOMAIN_2, RegionStructureId.LIQUID_RECYCLE_GATE_1);
    const d = diffSettings(
      make({
        structuresEnabled: new Set([sk]),
        metastorageRouteModes: new Map([[DOMAIN_1, "disabled"]]),
      }),
      make(),
    );
    expect(d.structures.has(sk)).toBe(true);
    expect(d.routes.has(DOMAIN_1)).toBe(true);
  });
});
