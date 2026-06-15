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
 */

import { describe, expect, test } from "vitest";
import { parseRawLimitKey, rawLimitKey } from "@/lib/raw-limits-helpers";
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
