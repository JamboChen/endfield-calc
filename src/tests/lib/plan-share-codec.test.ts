/**
 * Tests for the shared-plan settings codec (`src/lib/plan-share-codec.ts`).
 *
 * Pure-function coverage (no DOM):
 *   - encode → decode round-trips a shape to the same effective settings;
 *   - the default shape compacts to an (essentially empty) delta blob,
 *     while a customized shape grows — the "default users stay small"
 *     guarantee;
 *   - `shapesEqual` is the shared-vs-own gate: identical settings compare
 *     equal (→ no read-only view), different settings unequal;
 *   - corrupt / cross-version input degrades to `null` or is sanitized,
 *     never throws;
 *   - the manual `s=` hash transport survives `+` (which `URLSearchParams`
 *     would mangle to a space).
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
import { DomainId } from "@/types/domain";

// A genuinely-different-from-default shape: activate the second
// (default-inactive) domain and select it as the current region. Built
// off the default so the test hard-codes no ids beyond the enum.
const CUSTOM_SHAPE: PersistedShape = {
  ...DEFAULT_PERSISTED_SHAPE,
  domains: { inactive: [], current: DomainId.DOMAIN_2 },
};

describe("encode / decode round-trip", () => {
  test("the default shape round-trips to itself", () => {
    const decoded = decodeSettingsSnapshot(
      encodeSettingsSnapshot(DEFAULT_PERSISTED_SHAPE),
    );
    expect(decoded).not.toBeNull();
    expect(shapesEqual(decoded!, DEFAULT_PERSISTED_SHAPE)).toBe(true);
  });

  test("a customized shape round-trips to itself", () => {
    const decoded = decodeSettingsSnapshot(
      encodeSettingsSnapshot(CUSTOM_SHAPE),
    );
    expect(decoded).not.toBeNull();
    expect(shapesEqual(decoded!, CUSTOM_SHAPE)).toBe(true);
  });
});

describe("delta-from-default compaction", () => {
  test("the default shape encodes to the empty delta", () => {
    // Every field equals the default → the delta object is `{}`.
    expect(encodeSettingsSnapshot(DEFAULT_PERSISTED_SHAPE)).toBe(
      compressToEncodedURIComponent("{}"),
    );
  });

  test("a customized shape encodes to a larger blob than the default", () => {
    expect(encodeSettingsSnapshot(CUSTOM_SHAPE).length).toBeGreaterThan(
      encodeSettingsSnapshot(DEFAULT_PERSISTED_SHAPE).length,
    );
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
  test("malformed or empty blobs decode to null", () => {
    expect(decodeSettingsSnapshot("!!!not-lz-string!!!")).toBeNull();
    expect(decodeSettingsSnapshot("")).toBeNull();
  });

  test("unknown ids in an otherwise-valid delta are sanitized, not thrown", () => {
    const junk = compressToEncodedURIComponent(
      JSON.stringify({
        domains: { inactive: ["not_a_domain"], current: "nope" },
        aic: { unresearched: ["fake_tech"], capOverrides: [] },
      }),
    );
    const decoded = decodeSettingsSnapshot(junk);
    expect(decoded).not.toBeNull();
    expect(decoded!.domains.inactive).not.toContain("not_a_domain");
    expect(decoded!.aic.unresearched).not.toContain("fake_tech");
  });
});

describe("hash transport (withShareBlob / readShareBlobFromHash)", () => {
  test("withShareBlob appends s= only when a blob is present", () => {
    expect(withShareBlob("t=item_x:6", "ABC")).toBe("t=item_x:6&s=ABC");
    expect(withShareBlob("", "ABC")).toBe("s=ABC");
    expect(withShareBlob("t=item_x:6", "")).toBe("t=item_x:6");
  });

  test("readShareBlobFromHash extracts the blob (with or without '#')", () => {
    expect(readShareBlobFromHash("#t=item_x:6&s=ABC")).toBe("ABC");
    expect(readShareBlobFromHash("t=item_x:6&s=ABC")).toBe("ABC");
    expect(readShareBlobFromHash("#s=ABC")).toBe("ABC");
    expect(readShareBlobFromHash("#t=item_x:6")).toBeNull();
    expect(readShareBlobFromHash("#s=")).toBeNull();
  });

  test("a '+' in the blob survives extraction", () => {
    const blob = "aB+c-d$eF";
    expect(readShareBlobFromHash("#t=x&s=" + blob)).toBe(blob);
  });

  test("encode → withShareBlob → read → decode round-trips end to end", () => {
    const encoded = encodeSettingsSnapshot(CUSTOM_SHAPE);
    const extracted = readShareBlobFromHash(
      "#" + withShareBlob("t=item_x:6", encoded),
    );
    expect(extracted).toBe(encoded);
    expect(shapesEqual(decodeSettingsSnapshot(extracted!)!, CUSTOM_SHAPE)).toBe(
      true,
    );
  });
});
