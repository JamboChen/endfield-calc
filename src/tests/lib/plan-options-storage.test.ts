/**
 * Tests for the plan-option preference store.
 *
 * The node test env has no `window`; `vi.stubGlobal` supplies a fake one
 * with an in-memory localStorage, and the un-stubbed cases assert SSR /
 * storage-failure safety (mirrors `onboarding-storage.test.ts`).
 *
 * The load side is a trust boundary in the same way the settings blob
 * is — a hand-edited or stale payload must degrade to defaults rather
 * than feed the solver something it can't use — so the sanitizing tests
 * carry as much weight as the round-trip.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  loadPlanOptions,
  savePlanOption,
} from "@/lib/plan-options-storage";
import { DEFAULT_MACHINES_PER_VAPORIZER } from "@/lib/sustain-constants";

const KEY = "endfield-calc:plan-options-v1";

function stubStorage(seed?: string) {
  const store = new Map<string, string>();
  if (seed !== undefined) store.set(KEY, seed);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        store.set(k, v);
      },
    },
  });
  return store;
}

describe("plan-options-storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("an unset store reads as empty (caller keeps in-app defaults)", () => {
    stubStorage();
    expect(loadPlanOptions()).toEqual({});
  });

  test("each option round-trips", () => {
    stubStorage();
    savePlanOption("ceilMode", true);
    savePlanOption("binFusion", false);
    savePlanOption("powerSustain", true);
    savePlanOption("machinesPerVaporizer", 6);
    expect(loadPlanOptions()).toEqual({
      ceilMode: true,
      binFusion: false,
      powerSustain: true,
      machinesPerVaporizer: 6,
    });
  });

  test("writing one option leaves the others untouched", () => {
    // The anti-clobber property: toggling one option while viewing
    // someone else's link must not persist the values that link supplied.
    stubStorage();
    savePlanOption("powerSustain", true);
    savePlanOption("ceilMode", true);
    expect(loadPlanOptions()).toEqual({ powerSustain: true, ceilMode: true });
    savePlanOption("ceilMode", false);
    expect(loadPlanOptions()).toEqual({ powerSustain: true, ceilMode: false });
  });

  test("absent keys stay absent, so untouched options follow the default", () => {
    stubStorage();
    savePlanOption("ceilMode", true);
    const loaded = loadPlanOptions();
    expect(loaded).toEqual({ ceilMode: true });
    expect("binFusion" in loaded).toBe(false);
  });

  test("corrupt or wrong-shaped payloads read as empty", () => {
    for (const seed of ["", "not json", "null", "[]", '"a string"', "42"]) {
      stubStorage(seed);
      expect(loadPlanOptions()).toEqual({});
      vi.unstubAllGlobals();
    }
  });

  test("wrong-typed fields are dropped individually", () => {
    stubStorage(
      JSON.stringify({
        ceilMode: "yes",
        binFusion: 1,
        powerSustain: null,
        machinesPerVaporizer: "4",
        somethingElse: true,
      }),
    );
    expect(loadPlanOptions()).toEqual({});
  });

  test("an out-of-range coverage ratio falls back to the default", () => {
    for (const bad of [0, -3, 99]) {
      stubStorage(JSON.stringify({ machinesPerVaporizer: bad }));
      expect(loadPlanOptions().machinesPerVaporizer).toBe(
        DEFAULT_MACHINES_PER_VAPORIZER,
      );
      vi.unstubAllGlobals();
    }
  });

  test("a non-finite coverage ratio is dropped (JSON writes it as null)", () => {
    // `JSON.stringify` serializes NaN/Infinity as `null`, so these fail
    // the typeof check and drop out entirely rather than being clamped.
    // Same net result: the caller's `?? DEFAULT` supplies the default.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      stubStorage(JSON.stringify({ machinesPerVaporizer: bad }));
      expect(loadPlanOptions()).toEqual({});
      vi.unstubAllGlobals();
    }
  });

  test("a fractional coverage ratio is rounded to a whole machine count", () => {
    stubStorage(JSON.stringify({ machinesPerVaporizer: 3.7 }));
    expect(loadPlanOptions().machinesPerVaporizer).toBe(4);
  });

  test("SSR / no window: reads empty and writing is a safe no-op", () => {
    expect(loadPlanOptions()).toEqual({});
    expect(() => savePlanOption("ceilMode", true)).not.toThrow();
  });

  test("a throwing localStorage is swallowed", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(loadPlanOptions()).toEqual({});
    expect(() => savePlanOption("ceilMode", true)).not.toThrow();
  });
});
