/**
 * Tests for the shared-plan settings codec (`src/lib/plan-share-codec.ts`).
 *
 * Pure-function coverage (no DOM):
 *   - encode → decode round-trips a shape to the same effective settings,
 *     across every field type + a maximal (all-fields) shape;
 *   - the default shape compacts to `"0"`; the `0`/`1` flag picks the
 *     shorter of raw vs lz;
 *   - the raw (`0`) form is chat-safe (`[A-Za-z0-9_.~]` only);
 *   - `shapesEqual` is the shared-vs-own gate;
 *   - corrupt / unknown-flag / cross-version input degrades to `null` or
 *     is sanitized, never throws;
 *   - the manual `s=` hash transport;
 *   - GUARD tests asserting the codec's data assumptions (prefixes,
 *     charset, disabled-marker) so future data drift fails loudly.
 */

import { describe, expect, test } from "vitest";
import { compressToEncodedURIComponent } from "lz-string";

import {
  DEFAULT_PERSISTED_SHAPE,
  canonicalizeShape,
  type PersistedShape,
} from "@/hooks/useDomainSettings";
import {
  decodeSettingsSnapshot,
  encodeSettingsSnapshot,
  readShareBlobFromHash,
  shapesEqual,
  withShareBlob,
} from "@/lib/plan-share-codec";
import {
  facilities,
  items,
  metastorageSources,
  rawAvailabilityByDomain,
  regionStructures,
} from "@/data";
import { aicNodes, domains } from "@/data/aic-plans";
import { DomainId } from "@/types/domain";
import { FacilityId } from "@/types/constants";

const roundTrip = (s: PersistedShape) =>
  decodeSettingsSnapshot(encodeSettingsSnapshot(s));

// ── Real ids derived from the data (robust to data changes) ──

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

const msSource = [...metastorageSources.keys()][0];
if (!msSource) throw new Error("test setup: no Metastorage source");
const lockedDest = domains.find((d) => d.id !== msSource)?.id;

const someTech =
  aicNodes.find((n) => !n.id.startsWith("tech_group_"))?.id ?? aicNodes[0].id;

// Domains-only deviation (the common "activated Wuling" case).
const CUSTOM_SHAPE: PersistedShape = {
  ...DEFAULT_PERSISTED_SHAPE,
  domains: { inactive: [], current: DomainId.DOMAIN_2 },
};

// Every field populated with valid, active-where-required data.
const MAXIMAL: PersistedShape = {
  domains: { inactive: [], current: DomainId.DOMAIN_2 },
  aic: {
    unresearched: [someTech],
    capOverrides: [
      { facilityId: FacilityId.PUMP_1, domainId: DomainId.DOMAIN_1, value: 7 },
    ],
  },
  rawLimits: {
    overrides: [{ itemId: firstRaw.item, domainId: firstRaw.domain, value: 42 }],
  },
  structures: {
    disabled: [
      { domainId: firstStructure.domain, structureId: firstStructure.id },
    ],
  },
  metastorage: { routes: [{ source: msSource, mode: "disabled" }] },
};

describe("encode / decode round-trip", () => {
  test("the default shape round-trips to itself", () => {
    const decoded = roundTrip(DEFAULT_PERSISTED_SHAPE);
    expect(decoded).not.toBeNull();
    expect(shapesEqual(decoded!, DEFAULT_PERSISTED_SHAPE)).toBe(true);
  });

  test("a customized (domains-only) shape round-trips", () => {
    expect(shapesEqual(roundTrip(CUSTOM_SHAPE)!, CUSTOM_SHAPE)).toBe(true);
  });

  test("a maximal shape (every field) round-trips", () => {
    const decoded = roundTrip(MAXIMAL);
    expect(decoded).not.toBeNull();
    expect(shapesEqual(decoded!, MAXIMAL)).toBe(true);
  });

  test("aic unresearched (tech_ strip) round-trips", () => {
    const shape: PersistedShape = {
      ...DEFAULT_PERSISTED_SHAPE,
      aic: { unresearched: [someTech], capOverrides: [] },
    };
    expect(shapesEqual(roundTrip(shape)!, shape)).toBe(true);
  });

  test("a metastorage locked-destination route round-trips", () => {
    if (!lockedDest) return; // only meaningful with >=2 domains
    const shape: PersistedShape = {
      ...DEFAULT_PERSISTED_SHAPE,
      metastorage: { routes: [{ source: msSource, mode: lockedDest }] },
    };
    expect(shapesEqual(roundTrip(shape)!, shape)).toBe(true);
  });
});

describe("compaction + flag selection", () => {
  test("the default shape encodes to the raw empty delta `0`", () => {
    expect(encodeSettingsSnapshot(DEFAULT_PERSISTED_SHAPE)).toBe("0");
  });

  test("a small delta uses the raw form (flag 0)", () => {
    expect(encodeSettingsSnapshot(CUSTOM_SHAPE)[0]).toBe("0");
  });

  test("a large delta uses the lz form (flag 1) and still round-trips", () => {
    const big: PersistedShape = {
      ...DEFAULT_PERSISTED_SHAPE,
      aic: { unresearched: aicNodes.map((n) => n.id), capOverrides: [] },
    };
    expect(encodeSettingsSnapshot(big)[0]).toBe("1");
    expect(shapesEqual(roundTrip(big)!, big)).toBe(true);
  });

  test("customized settings are far smaller than the old JSON+lz form", () => {
    const oldForm = compressToEncodedURIComponent(
      JSON.stringify({ domains: { inactive: [], current: "domain_2" } }),
    );
    expect(encodeSettingsSnapshot(CUSTOM_SHAPE).length).toBeLessThan(
      oldForm.length,
    );
  });

  test("the raw (0) form uses only chat-safe characters", () => {
    const smallMulti: PersistedShape = {
      ...DEFAULT_PERSISTED_SHAPE,
      rawLimits: {
        overrides: [{ itemId: firstRaw.item, domainId: firstRaw.domain, value: 5 }],
      },
      metastorage: { routes: [{ source: msSource, mode: "disabled" }] },
    };
    const raw = encodeSettingsSnapshot(smallMulti);
    expect(raw[0]).toBe("0");
    expect(raw).toMatch(/^0[A-Za-z0-9_.~]*$/);
  });
});

describe("shapesEqual (shared-vs-own gate)", () => {
  test("canonicalization is idempotent → equal", () => {
    expect(
      shapesEqual(
        DEFAULT_PERSISTED_SHAPE,
        canonicalizeShape(DEFAULT_PERSISTED_SHAPE),
      ),
    ).toBe(true);
  });

  test("different effective settings compare unequal", () => {
    expect(shapesEqual(CUSTOM_SHAPE, DEFAULT_PERSISTED_SHAPE)).toBe(false);
  });
});

describe("corrupt / cross-version input", () => {
  test("empty / unrecognized-flag blobs decode to null", () => {
    expect(decodeSettingsSnapshot("")).toBeNull();
    expect(decodeSettingsSnapshot("Zbogus")).toBeNull();
    // A legacy JSON+lz blob has no `0`/`1` flag → unrecognized → null.
    expect(decodeSettingsSnapshot("Nbogus")).toBeNull();
  });

  test("a garbage lz (flag 1) payload never throws", () => {
    expect(() => decodeSettingsSnapshot("1@@@not-lz@@@")).not.toThrow();
  });

  test("unknown field letters are skipped (forward-compatible)", () => {
    const decoded = decodeSettingsSnapshot("0Zsomething");
    expect(decoded).not.toBeNull();
    expect(shapesEqual(decoded!, DEFAULT_PERSISTED_SHAPE)).toBe(true);
  });

  test("unknown ids in a valid blob are sanitized away, not thrown", () => {
    const decoded = decodeSettingsSnapshot(
      "0A1~fake_thing_zRnot_a_real_item~2~50",
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.aic.unresearched).toHaveLength(0);
    expect(decoded!.rawLimits?.overrides ?? []).toHaveLength(0);
  });
});

describe("hash transport (withShareBlob / readShareBlobFromHash)", () => {
  test("withShareBlob appends s= only when a blob is present", () => {
    expect(withShareBlob("t=item_x:6", "0ABC")).toBe("t=item_x:6&s=0ABC");
    expect(withShareBlob("", "0ABC")).toBe("s=0ABC");
    expect(withShareBlob("t=item_x:6", "")).toBe("t=item_x:6");
  });

  test("readShareBlobFromHash extracts the blob (with or without '#')", () => {
    expect(readShareBlobFromHash("#t=item_x:6&s=0ABC")).toBe("0ABC");
    expect(readShareBlobFromHash("t=item_x:6&s=0ABC")).toBe("0ABC");
    expect(readShareBlobFromHash("#s=0ABC")).toBe("0ABC");
    expect(readShareBlobFromHash("#t=item_x:6")).toBeNull();
    expect(readShareBlobFromHash("#s=")).toBeNull();
  });

  test("a '+' in the (lz) blob survives extraction", () => {
    const blob = "1aB+c-d$eF";
    expect(readShareBlobFromHash("#t=x&s=" + blob)).toBe(blob);
  });

  test("encode → withShareBlob → read → decode round-trips end to end", () => {
    const encoded = encodeSettingsSnapshot(MAXIMAL);
    const extracted = readShareBlobFromHash(
      "#" + withShareBlob("t=item_x:6", encoded),
    );
    expect(extracted).toBe(encoded);
    expect(shapesEqual(decodeSettingsSnapshot(extracted!)!, MAXIMAL)).toBe(true);
  });
});

describe("codec invariants (guards against data drift)", () => {
  const ID_RE = /^[a-z0-9_]+$/;

  test("every DomainId starts 'domain_', every AicTechId starts 'tech_'", () => {
    for (const d of domains) expect(d.id.startsWith("domain_")).toBe(true);
    for (const n of aicNodes) expect(n.id.startsWith("tech_")).toBe(true);
  });

  test("every settings-relevant id is lowercase [a-z0-9_]", () => {
    for (const i of items) expect(i.id).toMatch(ID_RE);
    for (const f of facilities) expect(f.id).toMatch(ID_RE);
    for (const n of aicNodes) expect(n.id).toMatch(ID_RE);
    for (const d of domains) expect(d.id).toMatch(ID_RE);
    for (const [, list] of regionStructures)
      for (const s of list) expect(s.id).toMatch(ID_RE);
  });

  test("no DomainId suffix collides with the disabled marker 'x'", () => {
    for (const d of domains) {
      expect(d.id.slice("domain_".length)).not.toBe("x");
    }
  });
});
