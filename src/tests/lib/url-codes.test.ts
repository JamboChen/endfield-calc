/**
 * Tests for the URL code registries (`src/lib/url-codes.ts` +
 * `src/data/{item,recipe,facility,structure}-codes.ts`).
 *
 * The completeness test is the "fail if we forget to regenerate" guard:
 * if a new id lands (via `extract:all`) but `extract:url-codes` wasn't
 * re-run, that id has no code, `encode*Ref` falls back to its full id
 * (which contains `_`), and the base36 assertion fails loudly.
 *
 * The lowercase-charset assertion is load-bearing beyond brevity: the
 * settings blob delimits fields with an uppercase letter, so an uppercase
 * character inside a code would be parsed as a new field
 * (`plan-share-codec.ts`).
 */

import { describe, expect, test } from "vitest";

import { facilities, items, recipes, regionStructures } from "@/data";
import { aicNodes } from "@/data/aic-plans";
import {
  decodeFacilityRef,
  decodeItemRef,
  decodeRecipeRef,
  decodeStructureRef,
  decodeTechRef,
  encodeFacilityRef,
  encodeItemRef,
  encodeRecipeRef,
  encodeStructureRef,
  encodeTechRef,
} from "@/lib/url-codes";

const structureIds = [
  ...new Set(
    [...regionStructures.values()].flatMap((list) => list.map((s) => s.id)),
  ),
];

const REGISTRIES = [
  {
    name: "item",
    ids: items.map((i) => i.id) as readonly string[],
    encode: encodeItemRef as (id: string) => string,
    decode: decodeItemRef as (token: string) => string | null,
    unknown: "definitely_not_an_item",
  },
  {
    name: "recipe",
    ids: recipes.map((r) => r.id) as readonly string[],
    encode: encodeRecipeRef as (id: string) => string,
    decode: decodeRecipeRef as (token: string) => string | null,
    unknown: "definitely_not_a_recipe",
  },
  {
    name: "facility",
    ids: facilities.map((f) => f.id) as readonly string[],
    encode: encodeFacilityRef as (id: string) => string,
    decode: decodeFacilityRef as (token: string) => string | null,
    unknown: "definitely_not_a_facility",
  },
  {
    name: "structure",
    ids: structureIds as readonly string[],
    encode: encodeStructureRef as (id: string) => string,
    decode: decodeStructureRef as (token: string) => string | null,
    unknown: "definitely_not_a_structure",
  },
  {
    name: "tech",
    ids: aicNodes.map((n) => n.id) as readonly string[],
    encode: encodeTechRef as (id: string) => string,
    decode: decodeTechRef as (token: string) => string | null,
    unknown: "definitely_not_a_tech",
  },
] as const;

describe.each(REGISTRIES)("$name code registry", (registry) => {
  test("is non-empty (guards against an empty data source)", () => {
    expect(registry.ids.length).toBeGreaterThan(0);
  });

  test("every id has a lowercase base36 code (regeneration guard)", () => {
    for (const id of registry.ids) {
      expect(registry.encode(id)).toMatch(/^[0-9a-z]+$/);
    }
  });

  test("codes are unique", () => {
    const codes = registry.ids.map(registry.encode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("codes round-trip, and legacy full ids still decode (back-compat)", () => {
    for (const id of registry.ids) {
      expect(registry.decode(registry.encode(id))).toBe(id);
      // Links shared before codes existed carried full ids — still resolve.
      expect(registry.decode(id)).toBe(id);
    }
  });

  test("unknown tokens decode to null", () => {
    expect(registry.decode(registry.unknown)).toBeNull();
    expect(registry.decode("zzzzzzz")).toBeNull(); // out-of-range code
    expect(registry.decode("")).toBeNull();
  });
});

describe("runtime-existence filter", () => {
  test("a registry entry with no runtime id decodes to null", () => {
    // Registry index 0 is `__multi_target__` — an ItemId enum member (so
    // the generator registers it) with no entry in `items`. Codes are
    // only honoured for ids that exist at runtime, which is what makes
    // tombstoned / stale registry entries safe to leave in place.
    expect(decodeItemRef("0")).toBeNull();
    expect(decodeItemRef("__multi_target__")).toBeNull();
  });
});
