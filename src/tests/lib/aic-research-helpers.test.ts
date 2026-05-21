import { describe, test, expect } from "vitest";

import {
  ALWAYS_UNLOCKED_FACILITIES,
  GATED_FACILITIES,
  capKey,
  computeEffectiveCaps,
  computeUnlockedFacilities,
  computeUnlockedModes,
  isGroupAtDefaults,
} from "@/lib/aic-research-helpers";
import type {
  AicNode,
  AicTechId,
  AicLayerId,
  FacilityBaseCap,
} from "@/types/aic";
import { AicGroupId } from "@/types/aic";
import type { DomainId } from "@/types/domain";
import { FacilityId } from "@/types/constants";

const id = (s: string): AicTechId => s as AicTechId;
const set = (...ids: string[]): ReadonlySet<AicTechId> =>
  new Set(ids.map((s) => s as AicTechId));

const layer = "L1" as AicLayerId;

/**
 * Synthetic nodes covering the three action kinds. The shape mirrors
 * what `extract:aic` emits but stays small and self-contained.
 */
const FURNACE_UNLOCK: AicNode = {
  id: id("furnace-unlock"),
  groupId: AicGroupId.BASIC,
  layerId: layer,
  preNodes: [],
  alreadyUnlocked: false,
  action: { kind: "unlock", facilityId: FacilityId.FURNANCE_1 },
  additionalFacilities: [],
};

const DEPOT_BUS_UNLOCK: AicNode = {
  id: id("depot-bus-unlock"),
  groupId: AicGroupId.BASIC,
  layerId: layer,
  preNodes: [],
  alreadyUnlocked: false,
  action: { kind: "unlock", facilityId: FacilityId.LOADER_1 },
  additionalFacilities: [FacilityId.UNLOADER_1],
};

const FURNACE_LIQUID_MODE: AicNode = {
  id: id("furnace-liquid-mode"),
  groupId: AicGroupId.WULING,
  layerId: layer,
  preNodes: [],
  alreadyUnlocked: false,
  action: {
    kind: "modeUnlock",
    facilityId: FacilityId.FURNANCE_1,
    modeName: "liquid",
  },
  additionalFacilities: [],
};

const OVEN_CAP_PLUS_1: AicNode = {
  id: id("oven-cap-1"),
  groupId: AicGroupId.WULING,
  layerId: layer,
  preNodes: [],
  alreadyUnlocked: false,
  action: {
    kind: "capRaise",
    facilityId: FacilityId.XIRANITE_OVEN_1,
    domainId: "domain_2" as DomainId,
    delta: 1,
  },
  additionalFacilities: [],
};

const OVEN_CAP_PLUS_2: AicNode = {
  id: id("oven-cap-2"),
  groupId: AicGroupId.WULING,
  layerId: layer,
  preNodes: [],
  alreadyUnlocked: false,
  action: {
    kind: "capRaise",
    facilityId: FacilityId.XIRANITE_OVEN_1,
    domainId: "domain_2" as DomainId,
    delta: 2,
  },
  additionalFacilities: [],
};

const NODES = [
  FURNACE_UNLOCK,
  DEPOT_BUS_UNLOCK,
  FURNACE_LIQUID_MODE,
  OVEN_CAP_PLUS_1,
  OVEN_CAP_PLUS_2,
] as const;

const OVEN_BASE_CAP: FacilityBaseCap = {
  facilityId: FacilityId.XIRANITE_OVEN_1,
  domainId: "domain_2" as DomainId,
  base: 1,
};

describe("aic-research-helpers", () => {
  describe("module-load invariants", () => {
    test("ALWAYS_UNLOCKED_FACILITIES and GATED_FACILITIES partition FacilityId", () => {
      const all = new Set<string>(Object.values(FacilityId));
      const gated = new Set<string>(GATED_FACILITIES);
      const always = new Set<string>(ALWAYS_UNLOCKED_FACILITIES);
      // Every facility is in exactly one of the two sets.
      for (const fid of all) {
        const inGated = gated.has(fid);
        const inAlways = always.has(fid);
        expect(inGated !== inAlways).toBe(true); // XOR
      }
      expect(gated.size + always.size).toBe(all.size);
    });

    test("xiranite_oven_1 is always-unlocked (cap-raises only, no facility-unlock node)", () => {
      // Real-data invariant — the upstream tech_jinlong_1_xiranite_oven_1
      // node is actionType=0 placeholder and is filtered out by extract:aic.
      // So the calc must treat xiranite_oven_1 as always-on.
      expect(ALWAYS_UNLOCKED_FACILITIES.has(FacilityId.XIRANITE_OVEN_1)).toBe(true);
      expect(GATED_FACILITIES.has(FacilityId.XIRANITE_OVEN_1)).toBe(false);
    });

    test("furnance_1 is gated (Basic AIC I)", () => {
      // Real data — the furnace IS gated by tech_tundra_1_furnance_1.
      // Default-unlocked at game start, but the gate exists.
      expect(GATED_FACILITIES.has(FacilityId.FURNANCE_1)).toBe(true);
      expect(ALWAYS_UNLOCKED_FACILITIES.has(FacilityId.FURNANCE_1)).toBe(false);
    });
  });

  describe("computeUnlockedFacilities", () => {
    test("with no research, only always-unlocked facilities are available", () => {
      const result = computeUnlockedFacilities(
        new Set(),
        null,
        NODES,
        [],
        new Set(),
      );
      expect(result.size).toBe(0);
    });

    test("researching a single-facility unlock adds that one facility", () => {
      const result = computeUnlockedFacilities(
        set("furnace-unlock"),
        null,
        NODES,
        [],
        new Set(),
      );
      expect(result.has(FacilityId.FURNANCE_1)).toBe(true);
      expect(result.has(FacilityId.LOADER_1)).toBe(false);
    });

    test("researching a multi-facility unlock adds primary + additionalFacilities", () => {
      const result = computeUnlockedFacilities(
        set("depot-bus-unlock"),
        null,
        NODES,
        [],
        new Set(),
      );
      expect(result.has(FacilityId.LOADER_1)).toBe(true);
      expect(result.has(FacilityId.UNLOADER_1)).toBe(true);
    });

    test("modeUnlock alone does NOT unlock the facility", () => {
      // The mode unlock targets `furnance_1`, but the user hasn't researched
      // the furnace unlock itself. The facility stays locked.
      const result = computeUnlockedFacilities(
        set("furnace-liquid-mode"),
        null,
        NODES,
        [],
        new Set(),
      );
      expect(result.has(FacilityId.FURNANCE_1)).toBe(false);
    });

    test("capRaise alone does NOT unlock the facility", () => {
      const result = computeUnlockedFacilities(
        set("oven-cap-1"),
        null,
        NODES,
        [],
        new Set(),
      );
      // xiranite_oven_1 is always-unlocked anyway, but the cap-raise
      // shouldn't ADD it to the unlocked set in our test (we pass an
      // empty alwaysUnlocked).
      expect(result.has(FacilityId.XIRANITE_OVEN_1)).toBe(false);
    });

    test("alwaysUnlocked seeds are included", () => {
      const result = computeUnlockedFacilities(
        new Set(),
        null,
        NODES,
        [],
        new Set([FacilityId.XIRANITE_OVEN_1, FacilityId.PLANTER_1]),
      );
      expect(result.has(FacilityId.XIRANITE_OVEN_1)).toBe(true);
      expect(result.has(FacilityId.PLANTER_1)).toBe(true);
    });

    test("activeDomains filter excludes facilities of inactive domains", () => {
      // Synthetic group mapping: 'basic' group → domain_active,
      // 'wuling' group → domain_inactive. The furnace-unlock node lives
      // in AicGroupId.BASIC (mapped to active); depot-bus in WULING
      // (mapped to inactive). Even though both are researched, only the
      // active-domain facility should surface.
      const synthGroups = [
        { id: AicGroupId.BASIC, domainId: "domain_active" as DomainId },
        { id: AicGroupId.WULING, domainId: "domain_inactive" as DomainId },
      ];
      const activeDomains = new Set(["domain_active" as DomainId]);

      // Re-tag the depot-bus-unlock node into WULING for this test.
      const taggedNodes = NODES.map((n) =>
        n.id === "depot-bus-unlock"
          ? { ...n, groupId: AicGroupId.WULING }
          : n,
      );

      const result = computeUnlockedFacilities(
        set("furnace-unlock", "depot-bus-unlock"),
        activeDomains,
        taggedNodes,
        synthGroups,
        new Set(),
      );
      expect(result.has(FacilityId.FURNANCE_1)).toBe(true);
      expect(result.has(FacilityId.LOADER_1)).toBe(false);
      expect(result.has(FacilityId.UNLOADER_1)).toBe(false);
    });

    test("activeDomains = null skips domain filtering entirely", () => {
      const result = computeUnlockedFacilities(
        set("furnace-unlock", "depot-bus-unlock"),
        null,
        NODES,
        [],
        new Set(),
      );
      expect(result.has(FacilityId.FURNANCE_1)).toBe(true);
      expect(result.has(FacilityId.LOADER_1)).toBe(true);
      expect(result.has(FacilityId.UNLOADER_1)).toBe(true);
    });
  });

  describe("isGroupAtDefaults", () => {
    test("returns true when every node in group matches its alreadyUnlocked", () => {
      // All NODES are alreadyUnlocked=false in fixtures. So defaults =
      // 'nothing researched in this group'.
      const result = isGroupAtDefaults(AicGroupId.WULING, new Set(), NODES);
      expect(result).toBe(true);
    });

    test("returns false when a non-default node is researched", () => {
      const result = isGroupAtDefaults(
        AicGroupId.WULING,
        set("furnace-liquid-mode"),
        NODES,
      );
      expect(result).toBe(false);
    });

    test("returns false when a default node is missing from researched", () => {
      // Make one node alreadyUnlocked=true; default state should include
      // it. Empty researched set → mismatch → not at defaults.
      const taggedNodes = NODES.map((n) =>
        n.id === "furnace-unlock" ? { ...n, alreadyUnlocked: true } : n,
      );
      const result = isGroupAtDefaults(AicGroupId.BASIC, new Set(), taggedNodes);
      expect(result).toBe(false);
    });

    test("only inspects nodes of the target group", () => {
      // Researching a Wuling node shouldn't affect Basic's at-defaults state.
      const result = isGroupAtDefaults(
        AicGroupId.BASIC,
        set("furnace-liquid-mode"), // WULING node
        NODES,
      );
      expect(result).toBe(true);
    });
  });

  describe("computeUnlockedModes", () => {
    test("every unlocked facility gets a 'normal' mode implicitly", () => {
      const unlocked = new Set([FacilityId.FURNANCE_1]);
      const result = computeUnlockedModes(new Set(), unlocked, NODES);
      const furnaceModes = result.get(FacilityId.FURNANCE_1);
      expect(furnaceModes).toBeDefined();
      expect(furnaceModes?.has("normal")).toBe(true);
      expect(furnaceModes?.has("liquid")).toBe(false);
    });

    test("researched modeUnlock adds its mode to the facility's set", () => {
      const unlocked = new Set([FacilityId.FURNANCE_1]);
      const result = computeUnlockedModes(
        set("furnace-liquid-mode"),
        unlocked,
        NODES,
      );
      const furnaceModes = result.get(FacilityId.FURNANCE_1);
      expect(furnaceModes?.has("normal")).toBe(true);
      expect(furnaceModes?.has("liquid")).toBe(true);
    });

    test("modeUnlock on a locked facility is ignored", () => {
      // Furnace facility not in `unlocked` → no mode entries at all.
      const result = computeUnlockedModes(
        set("furnace-liquid-mode"),
        new Set(),
        NODES,
      );
      expect(result.has(FacilityId.FURNANCE_1)).toBe(false);
    });

    test("multiple unlocked facilities each get independent 'normal' modes", () => {
      const unlocked = new Set([FacilityId.FURNANCE_1, FacilityId.GRINDER_1]);
      const result = computeUnlockedModes(new Set(), unlocked, NODES);
      expect(result.get(FacilityId.FURNANCE_1)?.has("normal")).toBe(true);
      expect(result.get(FacilityId.GRINDER_1)?.has("normal")).toBe(true);
    });
  });

  describe("computeEffectiveCaps", () => {
    const ovenKey = capKey(
      FacilityId.XIRANITE_OVEN_1,
      "domain_2" as DomainId,
    );

    test("base cap with no raises and no overrides equals base", () => {
      const result = computeEffectiveCaps(
        new Set(),
        new Map(),
        NODES,
        [OVEN_BASE_CAP],
      );
      const ovenCaps = result.get(FacilityId.XIRANITE_OVEN_1);
      expect(ovenCaps?.get("domain_2" as DomainId)).toBe(1);
    });

    test("researched cap raises sum on top of base", () => {
      const result = computeEffectiveCaps(
        set("oven-cap-1", "oven-cap-2"),
        new Map(),
        NODES,
        [OVEN_BASE_CAP],
      );
      // base(1) + delta(1) + delta(2) = 4
      expect(result.get(FacilityId.XIRANITE_OVEN_1)?.get("domain_2" as DomainId)).toBe(4);
    });

    test("override wins over base + raises", () => {
      const result = computeEffectiveCaps(
        set("oven-cap-1", "oven-cap-2"),
        new Map([[ovenKey, 99]]),
        NODES,
        [OVEN_BASE_CAP],
      );
      expect(result.get(FacilityId.XIRANITE_OVEN_1)?.get("domain_2" as DomainId)).toBe(99);
    });

    test("cap raises without a base cap still surface their delta", () => {
      const result = computeEffectiveCaps(
        set("oven-cap-1"),
        new Map(),
        NODES,
        [], // no base caps
      );
      expect(result.get(FacilityId.XIRANITE_OVEN_1)?.get("domain_2" as DomainId)).toBe(1);
    });

    test("override on a facility with no base or raise is surfaced", () => {
      const ovenKeyOther = capKey(
        FacilityId.FURNANCE_1,
        "domain_1" as DomainId,
      );
      const result = computeEffectiveCaps(
        new Set(),
        new Map([[ovenKeyOther, 42]]),
        NODES,
        [],
      );
      expect(result.get(FacilityId.FURNANCE_1)?.get("domain_1" as DomainId)).toBe(42);
    });

    test("unresearched cap-raise nodes do not contribute", () => {
      const result = computeEffectiveCaps(
        new Set(), // nothing researched
        new Map(),
        NODES,
        [OVEN_BASE_CAP],
      );
      expect(result.get(FacilityId.XIRANITE_OVEN_1)?.get("domain_2" as DomainId)).toBe(1);
    });
  });
});
