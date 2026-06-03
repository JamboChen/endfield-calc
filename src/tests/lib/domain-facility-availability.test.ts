/**
 * Tests for the per-region facility filter (`computeAvailableFacilities`)
 * and its composition with the existing AIC-unlock filter.
 *
 * The filter takes the AIC-unlocked facility set and the user's selected
 * factory region (`currentDomain`) and returns the intersection of:
 *   - AIC-unlocked (input passed through), AND
 *   - facilities whose `domains` is empty OR includes `currentDomain`.
 *
 * Tests use synthetic facilities so they're independent of game-data
 * drift. A second block targets the real catalog (8 facilities flagged
 * `["domain_2"]` after the schema refactor) to confirm the live filter
 * behaves as the data implies when planning in Valley IV.
 */

import { describe, test, expect } from "vitest";
import { computeAvailableFacilities } from "@/lib/aic-research-helpers";
import { facilities as gameFacilities } from "@/data";
import type { Facility } from "@/types";
import type { DomainId } from "@/types/domain";
import { FacilityId } from "@/types/constants";

const DOMAIN_1 = "domain_1" as DomainId;
const DOMAIN_2 = "domain_2" as DomainId;

/** Build a synthetic facility with overridable fields. */
const fac = (id: string, opts: Partial<Facility> = {}): Facility => ({
  id: id as FacilityId,
  tier: 1,
  category: 0,
  powerConsumption: 0,
  buffersIn: { belt: [], pipe: [] },
  buffersOut: { belt: [], pipe: [] },
  domains: [],
  ...opts,
});

describe("computeAvailableFacilities — synthetic catalog", () => {
  test("facility with empty `domains` is available in any region", () => {
    const facs = [fac("any_region")];
    const unlocked = new Set([facs[0].id]);

    expect(computeAvailableFacilities(unlocked, facs, DOMAIN_1).has(facs[0].id))
      .toBe(true);
    expect(computeAvailableFacilities(unlocked, facs, DOMAIN_2).has(facs[0].id))
      .toBe(true);
  });

  test("facility restricted to one domain is available there and filtered out elsewhere", () => {
    const facs = [fac("wuling_only", { domains: [DOMAIN_2] })];
    const unlocked = new Set([facs[0].id]);

    expect(computeAvailableFacilities(unlocked, facs, DOMAIN_2).has(facs[0].id))
      .toBe(true);
    expect(computeAvailableFacilities(unlocked, facs, DOMAIN_1).has(facs[0].id))
      .toBe(false);
  });

  test("facility with multi-domain restriction is available in any listed region", () => {
    const facs = [fac("multi", { domains: [DOMAIN_1, DOMAIN_2] })];
    const unlocked = new Set([facs[0].id]);

    expect(computeAvailableFacilities(unlocked, facs, DOMAIN_1).has(facs[0].id))
      .toBe(true);
    expect(computeAvailableFacilities(unlocked, facs, DOMAIN_2).has(facs[0].id))
      .toBe(true);
  });

  test("AIC-locked facility never appears even when domain-permitted", () => {
    const facs = [fac("locked", { domains: [] })];
    // unlocked set is empty — represents an AIC-locked facility.
    const unlocked = new Set<FacilityId>();

    expect(computeAvailableFacilities(unlocked, facs, DOMAIN_1).size).toBe(0);
    expect(computeAvailableFacilities(unlocked, facs, DOMAIN_2).size).toBe(0);
  });

  test("filter is an intersection — both gates must pass", () => {
    const facs = [
      fac("any_unlocked", { domains: [] }),
      fac("any_locked", { domains: [] }),
      fac("wuling_unlocked", { domains: [DOMAIN_2] }),
      fac("wuling_locked", { domains: [DOMAIN_2] }),
      fac("valley_unlocked", { domains: [DOMAIN_1] }),
    ];
    // AIC-unlocks every "_unlocked" facility.
    const unlocked = new Set(
      facs.filter((f) => f.id.endsWith("_unlocked")).map((f) => f.id),
    );

    // Planning in Valley IV: `any_unlocked` + `valley_unlocked` pass both gates.
    const inValley = computeAvailableFacilities(unlocked, facs, DOMAIN_1);
    expect(inValley.has(facs[0].id)).toBe(true);   // any_unlocked
    expect(inValley.has(facs[1].id)).toBe(false);  // any_locked (AIC gate)
    expect(inValley.has(facs[2].id)).toBe(false);  // wuling_unlocked (region gate)
    expect(inValley.has(facs[3].id)).toBe(false);  // wuling_locked (both gates)
    expect(inValley.has(facs[4].id)).toBe(true);   // valley_unlocked

    // Planning in Wuling: `any_unlocked` + `wuling_unlocked` pass.
    const inWuling = computeAvailableFacilities(unlocked, facs, DOMAIN_2);
    expect(inWuling.has(facs[0].id)).toBe(true);
    expect(inWuling.has(facs[1].id)).toBe(false);
    expect(inWuling.has(facs[2].id)).toBe(true);
    expect(inWuling.has(facs[3].id)).toBe(false);
    expect(inWuling.has(facs[4].id)).toBe(false);
  });

  test("ids in `unlockedFacilities` without a matching `Facility` entry are dropped (defensive)", () => {
    const facs = [fac("known")];
    const unlocked = new Set([
      facs[0].id,
      "phantom" as FacilityId, // not in catalog
    ]);
    const out = computeAvailableFacilities(unlocked, facs, DOMAIN_1);
    expect(out.has(facs[0].id)).toBe(true);
    expect(out.has("phantom" as FacilityId)).toBe(false);
  });
});

describe("computeAvailableFacilities — live game catalog", () => {
  // Snapshot: facilities the data layer flags as Wuling-only via
  // `Facility.domains` (set in `4dbd54b`). If a future schema refresh
  // changes this list, the test fails loudly — intentional, since the
  // change has user-visible consequences.
  const WULING_ONLY: ReadonlySet<FacilityId> = new Set([
    FacilityId.MIX_POOL_1,
    FacilityId.MIX_POOL_2,
    FacilityId.DISMANTLER_1,
    FacilityId.LIQUID_CLEANER_1,
    FacilityId.LIQUID_PURIFIER_1,
    FacilityId.PUMP_1,
    FacilityId.PUMP_2,
    // Synthetic facility from `src/data/manual-facilities.ts`; models
    // the three Wuling sewage inlet gates (`liquid_clean_gate_1/2/3`)
    // collapsed into one capped facility. `domains: ["domain_2"]`
    // matches the in-game placement restriction.
    FacilityId.LIQUID_CLEAN_GATE_1,
    FacilityId.XIRANITE_OVEN_1,
  ]);

  test("game-data snapshot: Facility.domains is in sync with the expected Wuling-only set", () => {
    const observed = new Set<FacilityId>();
    for (const f of gameFacilities) {
      if (f.domains.length > 0 && !f.domains.includes(DOMAIN_1)) {
        observed.add(f.id);
      }
    }
    expect(observed).toEqual(WULING_ONLY);
  });

  test("planning in Valley IV: Wuling-only facilities are filtered out", () => {
    // Assume the player has AIC-unlocked everything (worst case for
    // filtering — the region gate must still catch the Wuling-only ones).
    const unlocked = new Set(gameFacilities.map((f) => f.id));
    const available = computeAvailableFacilities(
      unlocked,
      gameFacilities,
      DOMAIN_1,
    );
    for (const id of WULING_ONLY) {
      expect(available.has(id)).toBe(false);
    }
    // Spot-check: unrestricted facilities still pass.
    expect(available.has(FacilityId.FURNANCE_1)).toBe(true);
    expect(available.has(FacilityId.GRINDER_1)).toBe(true);
    expect(available.has(FacilityId.UNLOADER_1)).toBe(true);
  });

  test("planning in Wuling: all AIC-unlocked facilities are available", () => {
    const unlocked = new Set(gameFacilities.map((f) => f.id));
    const available = computeAvailableFacilities(
      unlocked,
      gameFacilities,
      DOMAIN_2,
    );
    // Wuling-only facilities pass when planning in Wuling.
    for (const id of WULING_ONLY) {
      expect(available.has(id)).toBe(true);
    }
    // Unrestricted facilities also pass.
    expect(available.has(FacilityId.FURNANCE_1)).toBe(true);
  });
});
