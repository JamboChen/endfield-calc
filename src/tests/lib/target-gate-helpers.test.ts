/**
 * Unit tests for `resolveGateAction` — the runtime read that turns a
 * precomputed gate + live settings into "the earliest plan region whose
 * techs still need researching".
 */
import { describe, test, expect } from "vitest";

import { resolveGateAction } from "@/lib/target-gate-helpers";
import { DomainId } from "@/types/constants";
import type { AicTechId } from "@/types/aic";
import type { DomainId as DomainIdType } from "@/types/domain";
import type { TargetGate } from "@/types/target-gates";

const t = (s: string) => s as AicTechId;
const active = (...ids: DomainIdType[]) => new Set(ids);
const researched = (...ids: string[]) => new Set(ids.map(t));

// Factory in DOMAIN_2 needs a DOMAIN_1 plan tech (anywhere-facility) then
// DOMAIN_2 plan techs — the canonical cross-plan gate.
const crossPlanGate: TargetGate = {
  factories: [
    {
      factoryDomainId: DomainId.DOMAIN_2,
      planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: [t("d1_shaper")] },
        { domainId: DomainId.DOMAIN_2, techIds: [t("d2_mix"), t("d2_trans")] },
      ],
    },
  ],
};

describe("resolveGateAction", () => {
  test("returns null when there is no entry for the current factory region", () => {
    expect(
      resolveGateAction(
        crossPlanGate,
        DomainId.DOMAIN_1, // gate only has a DOMAIN_2 factory entry
        active(DomainId.DOMAIN_1, DomainId.DOMAIN_2),
        researched(),
      ),
    ).toBeNull();
  });

  test("returns null when every required tech is already researched", () => {
    expect(
      resolveGateAction(
        crossPlanGate,
        DomainId.DOMAIN_2,
        active(DomainId.DOMAIN_1, DomainId.DOMAIN_2),
        researched("d1_shaper", "d2_mix", "d2_trans"),
      ),
    ).toBeNull();
  });

  test("flashes the earliest plan region with a missing tech", () => {
    const action = resolveGateAction(
      crossPlanGate,
      DomainId.DOMAIN_2,
      active(DomainId.DOMAIN_1, DomainId.DOMAIN_2),
      researched(), // nothing researched
    );
    expect(action).toEqual({
      domainId: DomainId.DOMAIN_1,
      techIds: [t("d1_shaper")],
    });
  });

  test("advances to the next plan region once the earlier one is satisfied", () => {
    const action = resolveGateAction(
      crossPlanGate,
      DomainId.DOMAIN_2,
      active(DomainId.DOMAIN_1, DomainId.DOMAIN_2),
      researched("d1_shaper"), // domain_1 done, domain_2 still missing
    );
    expect(action).toEqual({
      domainId: DomainId.DOMAIN_2,
      techIds: [t("d2_mix"), t("d2_trans")],
    });
  });

  test("returns only the still-missing techs of the blocking region", () => {
    const action = resolveGateAction(
      crossPlanGate,
      DomainId.DOMAIN_2,
      active(DomainId.DOMAIN_1, DomainId.DOMAIN_2),
      researched("d1_shaper", "d2_mix"), // one of the two domain_2 techs done
    );
    expect(action).toEqual({
      domainId: DomainId.DOMAIN_2,
      techIds: [t("d2_trans")],
    });
  });

  test("returns null when a blocking plan region is not in the active roster", () => {
    // domain_1 plan tech is missing but domain_1 is (hypothetically) inactive:
    // not a clean in-factory tech gap, so no action.
    expect(
      resolveGateAction(
        crossPlanGate,
        DomainId.DOMAIN_2,
        active(DomainId.DOMAIN_2), // domain_1 inactive
        researched(),
      ),
    ).toBeNull();
  });
});
