import { describe, test, expect } from "vitest";

import {
  arePrereqsMet,
  buildDependentsIndex,
  buildNodeIndex,
  cascadeActivate,
  cascadeDeactivate,
  canActivate,
  findResearchedDependents,
  previewActivationDelta,
} from "@/lib/aic-cascade";
import type { AicNode, AicTechId, AicLayerId } from "@/types/aic";
import { AicGroupId } from "@/types/aic";
import { FacilityId } from "@/types/constants";

/**
 * Synthetic AIC node fixtures. Deliberately small and hand-crafted so the
 * cascade semantics can be tested in isolation from upstream-data drift.
 *
 * Graph (arrows = "requires"):
 *
 *   A (alreadyUnlocked)
 *     ↑
 *   B ─── ←── D
 *     ↑       ↑
 *   C ────────┘
 *     ↑
 *   E
 */
const A: AicNode = {
  id: "A" as AicTechId,
  groupId: AicGroupId.BASIC,
  layerId: "L1" as AicLayerId,
  preNodes: [],
  alreadyUnlocked: true,
  action: { kind: "unlock", facilityId: FacilityId.FURNANCE_1 },
  additionalFacilities: [],
};

const B: AicNode = {
  id: "B" as AicTechId,
  groupId: AicGroupId.BASIC,
  layerId: "L1" as AicLayerId,
  preNodes: ["A" as AicTechId],
  alreadyUnlocked: false,
  action: { kind: "unlock", facilityId: FacilityId.GRINDER_1 },
  additionalFacilities: [],
};

const C: AicNode = {
  id: "C" as AicTechId,
  groupId: AicGroupId.BASIC,
  layerId: "L2" as AicLayerId,
  preNodes: ["B" as AicTechId],
  alreadyUnlocked: false,
  action: { kind: "unlock", facilityId: FacilityId.SHAPER_1 },
  additionalFacilities: [],
};

const D: AicNode = {
  id: "D" as AicTechId,
  groupId: AicGroupId.BASIC,
  layerId: "L2" as AicLayerId,
  preNodes: ["B" as AicTechId, "C" as AicTechId],
  alreadyUnlocked: false,
  action: { kind: "unlock", facilityId: FacilityId.WINDER_1 },
  additionalFacilities: [],
};

const E: AicNode = {
  id: "E" as AicTechId,
  groupId: AicGroupId.BASIC,
  layerId: "L3" as AicLayerId,
  preNodes: ["C" as AicTechId],
  alreadyUnlocked: false,
  action: { kind: "unlock", facilityId: FacilityId.COMPONENT_MC_1 },
  additionalFacilities: [],
};

const NODES = [A, B, C, D, E] as const;
const id = (s: string): AicTechId => s as AicTechId;
const set = (...ids: string[]): ReadonlySet<AicTechId> =>
  new Set(ids.map((s) => s as AicTechId));

describe("aic-cascade helpers", () => {
  describe("buildNodeIndex", () => {
    test("indexes nodes by id", () => {
      const idx = buildNodeIndex(NODES);
      expect(idx.size).toBe(5);
      expect(idx.get(id("C"))).toBe(C);
    });
  });

  describe("buildDependentsIndex", () => {
    test("reverses preNode edges", () => {
      const deps = buildDependentsIndex(NODES);
      expect(deps.get(id("A"))).toEqual(new Set([id("B")]));
      expect(deps.get(id("B"))).toEqual(new Set([id("C"), id("D")]));
      expect(deps.get(id("C"))).toEqual(new Set([id("D"), id("E")]));
      // Leaves: D and E have no dependents.
      expect(deps.get(id("D"))).toBeUndefined();
      expect(deps.get(id("E"))).toBeUndefined();
    });
  });

  describe("arePrereqsMet", () => {
    test("returns true when all preNodes are researched", () => {
      expect(arePrereqsMet(C, set("A", "B"))).toBe(true);
    });
    test("returns false when any preNode is missing", () => {
      expect(arePrereqsMet(D, set("A", "B"))).toBe(false); // missing C
    });
    test("returns true for nodes with no preNodes", () => {
      expect(arePrereqsMet(A, new Set())).toBe(true);
    });
  });

  describe("canActivate", () => {
    test("research-able node with met prereqs returns true", () => {
      expect(canActivate(C, set("A", "B"))).toBe(true);
    });
    test("research-able node with unmet prereqs returns false", () => {
      expect(canActivate(C, set("A"))).toBe(false);
    });
    test("already-researched node returns true", () => {
      expect(canActivate(C, set("A", "B", "C"))).toBe(true);
    });
  });

  describe("cascadeActivate", () => {
    test("activates a single node and all transitive prereqs", () => {
      const next = cascadeActivate([id("E")], new Set(), NODES);
      expect(next).toEqual(set("A", "B", "C", "E"));
    });

    test("does not mutate the input set", () => {
      const before = set("A");
      const next = cascadeActivate([id("C")], before, NODES);
      expect(before).toEqual(set("A"));
      expect(next).toEqual(set("A", "B", "C"));
    });

    test("idempotent on already-researched targets", () => {
      const next = cascadeActivate([id("C")], set("A", "B", "C"), NODES);
      expect(next).toEqual(set("A", "B", "C"));
    });

    test("activating multiple targets dedupes shared prereqs", () => {
      const next = cascadeActivate([id("D"), id("E")], new Set(), NODES);
      expect(next).toEqual(set("A", "B", "C", "D", "E"));
    });

    test("unknown ids are ignored defensively", () => {
      const next = cascadeActivate(
        [id("UNKNOWN"), id("B")],
        new Set(),
        NODES,
      );
      expect(next).toEqual(set("A", "B"));
    });
  });

  describe("cascadeDeactivate", () => {
    test("removes a node and dependents that would lose a prereq", () => {
      // Start fully researched. Deactivating B should also drop C, D, E.
      const next = cascadeDeactivate(
        [id("B")],
        set("A", "B", "C", "D", "E"),
        NODES,
      );
      expect(next).toEqual(set("A"));
    });

    test("alreadyUnlocked nodes cannot be deactivated", () => {
      const next = cascadeDeactivate([id("A")], set("A"), NODES);
      expect(next).toEqual(set("A"));
    });

    test("does not mutate the input set", () => {
      const before = set("A", "B", "C");
      const next = cascadeDeactivate([id("C")], before, NODES);
      expect(before).toEqual(set("A", "B", "C"));
      expect(next).toEqual(set("A", "B"));
    });

    test("partial deactivate only drops dependents that lose a prereq", () => {
      // D has TWO preNodes (B, C). Removing only C still leaves D's other
      // prereq B satisfied — but B alone isn't enough, so D still drops.
      // (D's preNodes = [B, C], so missing C means prereqs unmet → drop.)
      const next = cascadeDeactivate(
        [id("C")],
        set("A", "B", "C", "D"),
        NODES,
      );
      expect(next).toEqual(set("A", "B"));
    });

    test("dependent already absent has no further effect", () => {
      const next = cascadeDeactivate([id("B")], set("A", "B"), NODES);
      expect(next).toEqual(set("A"));
    });
  });

  describe("findResearchedDependents", () => {
    test("returns researched dependents only", () => {
      const deps = findResearchedDependents(
        [id("B")],
        set("A", "B", "C", "D"),
        NODES,
      );
      // E is not researched → not returned.
      expect(deps).toEqual(new Set([id("C"), id("D")]));
    });

    test("excludes alreadyUnlocked nodes", () => {
      // A is a preNode of B but A is alreadyUnlocked; deactivating "above
      // the tree" via a no-op `targetIds=[A]` wouldn't include A itself.
      // (Pure regression of the exclusion rule.)
      const allResearched = set("A", "B");
      const deps = findResearchedDependents([id("A")], allResearched, NODES);
      expect(deps).toEqual(new Set([id("B")]));
    });

    test("excludes target ids themselves", () => {
      const deps = findResearchedDependents(
        [id("C")],
        set("A", "B", "C", "E"),
        NODES,
      );
      // C is the target; deps are E (researched dependent of C).
      // D is NOT researched here, so not returned.
      expect(deps).toEqual(new Set([id("E")]));
    });
  });

  describe("previewActivationDelta", () => {
    test("counts primary targets and prereqs separately", () => {
      // Target = [E]. Current = {}. After cascade: {A, B, C, E}.
      // A is alreadyUnlocked so it's still added (just immutable);
      // primary = 1 (E itself), prereqs = 3 (A, B, C).
      const delta = previewActivationDelta([id("E")], new Set(), NODES);
      expect(delta).toEqual({ primary: 1, prereqs: 3 });
    });

    test("returns zero when nothing changes", () => {
      const delta = previewActivationDelta(
        [id("B")],
        set("A", "B"),
        NODES,
      );
      expect(delta).toEqual({ primary: 0, prereqs: 0 });
    });

    test("counts only new additions", () => {
      const delta = previewActivationDelta([id("D")], set("A", "B"), NODES);
      // Adds D itself (primary=1) and C (prereq=1). A, B already in.
      expect(delta).toEqual({ primary: 1, prereqs: 1 });
    });
  });
});
