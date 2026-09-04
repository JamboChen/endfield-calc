/**
 * Tests for `sanitizePersistedShape` — the single validation path every
 * settings payload passes through, from localStorage, a shared link or a
 * saved plan file.
 *
 * It is the trust boundary for URL content, so most of this file feeds it
 * hostile input directly rather than through a codec: the codec's own
 * tests can only reach it with things the encoder can produce, which is
 * exactly the input that is never dangerous.
 *
 * The contract: unknown ids are DROPPED, never admitted and never thrown
 * on, and the invariant `currentDomain ∈ activeDomains` always holds on
 * the way out.
 */

import { describe, expect, test } from "vitest";

import {
  DEFAULT_PERSISTED_SHAPE,
  canonicalizeShape,
  sanitizePersistedShape,
  type PersistedShape,
} from "@/lib/persisted-shape";
import { facilities, rawAvailabilityByDomain, regionStructures } from "@/data";
import { aicNodes, domains } from "@/data/aic-plans";
import { DomainId } from "@/types/domain";

/** A minimal valid nested shape, ready to be corrupted per-test. */
function shape(overrides: Record<string, unknown> = {}): unknown {
  return {
    domains: { inactive: [], current: DomainId.DOMAIN_1 },
    aic: { unresearched: [], capOverrides: [] },
    rawLimits: { overrides: [] },
    structures: { disabled: [] },
    metastorage: { routes: [] },
    ...overrides,
  };
}

const firstRaw = (() => {
  for (const [domain, set] of rawAvailabilityByDomain) {
    for (const item of set) return { domain, item };
  }
  throw new Error("test setup: no raw material in rawAvailabilityByDomain");
})();

const firstStructure = (() => {
  for (const [domain, list] of regionStructures) {
    if (list.length > 0) return { domain, id: list[0].id };
  }
  throw new Error("test setup: no region structure in regionStructures");
})();

describe("shape recognition", () => {
  test("non-shapes return null rather than a default", () => {
    // `null` lets the caller keep the user's own settings; silently
    // returning defaults would look like a deliberate reset.
    for (const bad of [null, undefined, 42, "str", [], {}, { aic: 1 }]) {
      expect(sanitizePersistedShape(bad)).toBeNull();
    }
  });

  test("a valid shape survives intact", () => {
    const result = sanitizePersistedShape(shape());
    expect(result).not.toBeNull();
    expect(result!.domains.current).toBe(DomainId.DOMAIN_1);
  });

  test("never throws, whatever the payload", () => {
    for (const bad of [
      shape({ aic: { unresearched: "nope", capOverrides: "nope" } }),
      shape({ domains: { inactive: "nope", current: 7 } }),
      shape({ rawLimits: { overrides: [null, 1, "x"] } }),
      shape({ structures: { disabled: [{}] } }),
      shape({ metastorage: { routes: [{ source: null }] } }),
    ]) {
      expect(() => sanitizePersistedShape(bad)).not.toThrow();
    }
  });
});

describe("unknown ids are dropped, not admitted", () => {
  test("unknown AIC techs", () => {
    const out = sanitizePersistedShape(
      shape({ aic: { unresearched: ["tech_not_real", 7, null], capOverrides: [] } }),
    );
    expect(out!.aic.unresearched).toHaveLength(0);
  });

  test("a real AIC tech is kept", () => {
    const real = aicNodes[0].id;
    const out = sanitizePersistedShape(
      shape({ aic: { unresearched: [real], capOverrides: [] } }),
    );
    expect(out!.aic.unresearched).toEqual([real]);
  });

  test("unknown domains in the inactive list", () => {
    const out = sanitizePersistedShape(
      shape({ domains: { inactive: ["domain_nope", 3], current: DomainId.DOMAIN_1 } }),
    );
    expect(out!.domains.inactive).toHaveLength(0);
  });

  test("cap overrides for an unknown facility", () => {
    const out = sanitizePersistedShape(
      shape({
        aic: {
          unresearched: [],
          capOverrides: [
            { facilityId: "facility_not_real", domainId: DomainId.DOMAIN_1, value: 5 },
          ],
        },
      }),
    );
    expect(out!.aic.capOverrides).toHaveLength(0);
  });

  test("a cap override for a real facility is kept", () => {
    const out = sanitizePersistedShape(
      shape({
        aic: {
          unresearched: [],
          capOverrides: [
            { facilityId: facilities[0].id, domainId: DomainId.DOMAIN_1, value: 5 },
          ],
        },
      }),
    );
    expect(out!.aic.capOverrides).toHaveLength(1);
  });

  test("raw limits for an item the region doesn't supply", () => {
    // A real item, but not a raw of this region — the case a bogus-id
    // test can't reach.
    const notARaw = facilities[0].id as unknown as string;
    const out = sanitizePersistedShape(
      shape({
        rawLimits: {
          overrides: [{ itemId: notARaw, domainId: firstRaw.domain, value: 5 }],
        },
      }),
    );
    expect(out!.rawLimits?.overrides ?? []).toHaveLength(0);
  });

  test("a raw limit for an item the region does supply is kept", () => {
    const out = sanitizePersistedShape(
      shape({
        rawLimits: {
          overrides: [
            { itemId: firstRaw.item, domainId: firstRaw.domain, value: 5 },
          ],
        },
      }),
    );
    expect(out!.rawLimits?.overrides ?? []).toHaveLength(1);
  });

  test("disabled entries for an unknown structure", () => {
    const out = sanitizePersistedShape(
      shape({
        structures: {
          disabled: [{ structureId: "not_real", domainId: firstStructure.domain }],
        },
      }),
    );
    expect(out!.structures?.disabled ?? []).toHaveLength(0);
  });

  test("a real (domain, structure) pair is kept", () => {
    const out = sanitizePersistedShape(
      shape({
        structures: {
          disabled: [
            { structureId: firstStructure.id, domainId: firstStructure.domain },
          ],
        },
      }),
    );
    expect(out!.structures?.disabled ?? []).toHaveLength(1);
  });

  test("metastorage routes from an unknown source", () => {
    const out = sanitizePersistedShape(
      shape({ metastorage: { routes: [{ source: "domain_nope", mode: "disabled" }] } }),
    );
    expect(out!.metastorage?.routes ?? []).toHaveLength(0);
  });
});

describe("numeric guards", () => {
  const cap = (value: unknown) =>
    sanitizePersistedShape(
      shape({
        aic: {
          unresearched: [],
          capOverrides: [
            { facilityId: facilities[0].id, domainId: DomainId.DOMAIN_1, value },
          ],
        },
      }),
    )!.aic.capOverrides;

  const raw = (value: unknown) =>
    sanitizePersistedShape(
      shape({
        rawLimits: {
          overrides: [
            { itemId: firstRaw.item, domainId: firstRaw.domain, value },
          ],
        },
      }),
    )!.rawLimits?.overrides ?? [];

  test("caps reject non-numbers, non-finite and negative values", () => {
    for (const bad of ["5", null, NaN, Infinity, -1]) expect(cap(bad)).toHaveLength(0);
    expect(cap(0)).toHaveLength(1);
    expect(cap(7)).toHaveLength(1);
  });

  test("raw limits reject non-numbers, non-finite and negative values", () => {
    for (const bad of ["5", null, NaN, Infinity, -1]) expect(raw(bad)).toHaveLength(0);
    expect(raw(0)).toHaveLength(1);
  });
});

describe("currentDomain ∈ activeDomains invariant", () => {
  // `App.tsx` non-null-asserts on this, so a violation is a crash.
  const togglable = domains.find((d) => !d.isPinned);

  test("an unknown current domain is replaced, never passed through", () => {
    const out = sanitizePersistedShape(
      shape({ domains: { inactive: [], current: "domain_nope" } }),
    );
    const active = domains
      .filter((d) => !out!.domains.inactive.includes(d.id))
      .map((d) => d.id);
    expect(active).toContain(out!.domains.current ?? DEFAULT_PERSISTED_SHAPE.domains.current);
  });

  test("a current domain that is also inactive is not left dangling", () => {
    if (!togglable) throw new Error("test setup: no togglable domain");
    const out = sanitizePersistedShape(
      shape({ domains: { inactive: [togglable.id], current: togglable.id } }),
    );
    expect(out!.domains.current).not.toBe(togglable.id);
  });
});

describe("canonicalization", () => {
  test("is idempotent", () => {
    const once = canonicalizeShape(DEFAULT_PERSISTED_SHAPE);
    expect(canonicalizeShape(once)).toEqual(once);
  });

  test("sanitizing an already-sanitized shape is a fixed point", () => {
    const once = sanitizePersistedShape(shape()) as PersistedShape;
    expect(sanitizePersistedShape(once)).toEqual(once);
  });
});
