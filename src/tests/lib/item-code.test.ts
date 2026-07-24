/**
 * Tests for the item-code registry (`src/lib/item-code.ts` +
 * `src/data/item-codes.ts`).
 *
 * The first test is the "fail if we forget to regenerate" guard: if a new
 * item lands (via `extract:items`) but `extract:item-codes` wasn't re-run,
 * that item has no code, `encodeItemRef` falls back to its full id (which
 * contains `_`), and the base36 assertion fails loudly.
 */

import { describe, expect, test } from "vitest";

import { items } from "@/data";
import { decodeItemRef, encodeItemRef } from "@/lib/item-code";

describe("item-code registry", () => {
  test("every item has a base36 code (regeneration guard)", () => {
    for (const item of items) {
      expect(encodeItemRef(item.id)).toMatch(/^[0-9a-z]+$/);
    }
  });

  test("codes are unique across items", () => {
    const codes = items.map((i) => encodeItemRef(i.id));
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("codes round-trip, and legacy full ids still decode (back-compat)", () => {
    for (const item of items) {
      const code = encodeItemRef(item.id);
      expect(decodeItemRef(code)).toBe(item.id);
      // Links shared before codes existed carried full ids — still resolve.
      expect(decodeItemRef(item.id)).toBe(item.id);
    }
  });

  test("unknown tokens decode to null", () => {
    expect(decodeItemRef("definitely_not_an_item")).toBeNull();
    expect(decodeItemRef("zzzzzzz")).toBeNull(); // out-of-range code
    expect(decodeItemRef("")).toBeNull();
  });
});
