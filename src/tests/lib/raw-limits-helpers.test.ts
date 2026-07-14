/**
 * Tests for raw-limits key helpers.
 *
 * The hook (`useDomainSettings.rawLimits`) is React-stateful and not
 * directly exercised here — the codebase convention skips DOM tests
 * (see `src/tests/lib/aic-integration.test.ts:1-11`). Hook persistence
 * (the defensive `(itemId, domainId)`-validity filter, the missing-
 * field-tolerant loader) is covered implicitly by the type system + a
 * code review of `loadFromStorage` in `useDomainSettings.ts`; the same
 * pattern that `capOverrides` uses, which has no direct test today.
 *
 * What this file does cover:
 *   - `rawLimitKey` produces a NUL-delimited string matching the
 *     `capKey` convention so the two parallel cap-override systems are
 *     mutually inspectable.
 *   - `parseRawLimitKey` round-trips a valid key.
 *   - `parseRawLimitKey` returns `null` on malformed input.
 *   - `buildRawMaterialCaps` precedence: defaults seed the map, valid
 *     same-region overrides win, invalid / other-region / malformed
 *     entries are ignored (the default survives).
 */

import { describe, expect, test } from "vitest";
import {
  buildRawMaterialCaps,
  parseRawLimitKey,
  rawLimitKey,
} from "@/lib/raw-limits-helpers";
import type { ItemId } from "@/types";
import { DomainId } from "@/types/domain";

describe("rawLimitKey / parseRawLimitKey", () => {
  test("encodes a valid (itemId, domainId) pair", () => {
    const key = rawLimitKey(
      "item_iron_ore" as ItemId,
      DomainId.DOMAIN_1,
    );
    expect(key).toBe("item_iron_ore\u0000domain_1");
  });

  test("round-trips through parseRawLimitKey", () => {
    const itemId = "item_copper_ore" as ItemId;
    const domainId = DomainId.DOMAIN_2;
    const key = rawLimitKey(itemId, domainId);
    const parsed = parseRawLimitKey(key);
    expect(parsed).toEqual({ itemId, domainId });
  });

  test("uses the NUL delimiter (mirrors capKey convention)", () => {
    const key = rawLimitKey(
      "item_quartz_sand" as ItemId,
      DomainId.DOMAIN_1,
    );
    // Same delimiter as `capKey` in `aic-research-helpers.ts:48`.
    // Keeps the two cap-override storage systems mutually inspectable
    // (split-on-\u0000 works on both).
    expect(key.includes("\u0000")).toBe(true);
    expect(key.split("\u0000")).toHaveLength(2);
  });

  test("parseRawLimitKey returns null for missing delimiter", () => {
    expect(parseRawLimitKey("no-delimiter-here")).toBeNull();
  });

  test("parseRawLimitKey returns null for empty string", () => {
    expect(parseRawLimitKey("")).toBeNull();
  });

  test("parseRawLimitKey handles ids with arbitrary characters (excluding NUL)", () => {
    // Defensive: IDs in this codebase don't contain NUL, but the
    // helper should still split correctly on the first delimiter.
    const odd = rawLimitKey(
      "item_with_underscore" as ItemId,
      "domain_with-hyphen" as unknown as DomainId,
    );
    expect(parseRawLimitKey(odd)).toEqual({
      itemId: "item_with_underscore",
      domainId: "domain_with-hyphen",
    });
  });
});

describe("buildRawMaterialCaps", () => {
  const IRON = "item_iron_ore" as ItemId;
  const ORIGINIUM = "item_originium_ore" as ItemId;
  const MUCK = "item_muck_feces_1" as ItemId;

  const DEFAULTS: ReadonlyMap<ItemId, number> = new Map([
    [IRON, 1080],
    [ORIGINIUM, 560],
  ]);

  test("no overrides → returns the defaults verbatim", () => {
    const caps = buildRawMaterialCaps(DEFAULTS, new Map(), DomainId.DOMAIN_1);
    expect(caps).toEqual(new Map([[IRON, 1080], [ORIGINIUM, 560]]));
  });

  test("no defaults + no overrides → empty (everything unconstrained)", () => {
    const caps = buildRawMaterialCaps(undefined, new Map(), DomainId.DOMAIN_1);
    expect(caps.size).toBe(0);
  });

  test("a same-region override wins over the default", () => {
    const overrides = new Map([[rawLimitKey(IRON, DomainId.DOMAIN_1), 300]]);
    const caps = buildRawMaterialCaps(DEFAULTS, overrides, DomainId.DOMAIN_1);
    expect(caps.get(IRON)).toBe(300);
    expect(caps.get(ORIGINIUM)).toBe(560); // untouched default
  });

  test("a zero override wins (0 is a valid cap, not 'unset')", () => {
    const overrides = new Map([[rawLimitKey(IRON, DomainId.DOMAIN_1), 0]]);
    const caps = buildRawMaterialCaps(DEFAULTS, overrides, DomainId.DOMAIN_1);
    expect(caps.get(IRON)).toBe(0);
  });

  test("an override adds a cap for an item without a default", () => {
    const overrides = new Map([[rawLimitKey(MUCK, DomainId.DOMAIN_1), 45]]);
    const caps = buildRawMaterialCaps(DEFAULTS, overrides, DomainId.DOMAIN_1);
    expect(caps.get(MUCK)).toBe(45);
  });

  test("other-region overrides are ignored (default survives)", () => {
    const overrides = new Map([[rawLimitKey(IRON, DomainId.DOMAIN_2), 300]]);
    const caps = buildRawMaterialCaps(DEFAULTS, overrides, DomainId.DOMAIN_1);
    expect(caps.get(IRON)).toBe(1080);
  });

  test("invalid override values are ignored (default survives)", () => {
    const key = rawLimitKey(IRON, DomainId.DOMAIN_1);
    for (const bad of [-1, NaN, Infinity]) {
      const caps = buildRawMaterialCaps(
        DEFAULTS,
        new Map([[key, bad]]),
        DomainId.DOMAIN_1,
      );
      expect(caps.get(IRON), `value ${bad}`).toBe(1080);
    }
  });

  test("malformed override keys are ignored", () => {
    const overrides = new Map([["no-delimiter-here", 300]]);
    const caps = buildRawMaterialCaps(DEFAULTS, overrides, DomainId.DOMAIN_1);
    expect(caps).toEqual(new Map([[IRON, 1080], [ORIGINIUM, 560]]));
  });

  test("does not mutate the defaults map", () => {
    const defaults = new Map<ItemId, number>([[IRON, 1080]]);
    const overrides = new Map([[rawLimitKey(IRON, DomainId.DOMAIN_1), 300]]);
    buildRawMaterialCaps(defaults, overrides, DomainId.DOMAIN_1);
    expect(defaults.get(IRON)).toBe(1080);
  });
});
