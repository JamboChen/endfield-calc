/**
 * Variant-filter helper (`src/lib/variant-filter.ts`).
 *
 * Pins the two-mode contract:
 *   - `cap-zero-only` (calculator-side defensive backstop)
 *   - `structure-aware` (App-side rule with resolved Settings state)
 *
 * Tests run against the real `facilityRecipeVariants` registry — today
 * the only entry is `LIQUID_CLEAN_GATE_1`. The helper's per-facility
 * loop is trivially correct, so adding synthetic registry entries here
 * would add ceremony without coverage. End-to-end multi-entry cases
 * are covered by `structures-disposal.test.ts` against real plans.
 */
import { describe, test, expect } from "vitest";
import { computeVariantExclusions } from "@/lib/variant-filter";
import { facilityRecipeVariants } from "@/data";
import { FacilityId, RecipeId } from "@/types/constants";

const LCG1 = FacilityId.LIQUID_CLEAN_GATE_1;
const VARIANTS = facilityRecipeVariants.get(LCG1)!;
const DEFAULT_VARIANT = VARIANTS.default; // LIQUID_CLEAN_GATE_1_DISPOSAL
const TOGGLED_VARIANT = VARIANTS.toggled; // LIQUID_CLEAN_GATE_1_BYPRODUCT

describe("computeVariantExclusions — cap-zero-only mode", () => {
  test("undefined facilityCaps excludes both variants", () => {
    const excluded = computeVariantExclusions({ mode: "cap-zero-only" });
    expect(excluded.has(DEFAULT_VARIANT)).toBe(true);
    expect(excluded.has(TOGGLED_VARIANT)).toBe(true);
    expect(excluded.size).toBe(2);
  });

  test("empty facilityCaps excludes both variants (cap missing = 0)", () => {
    const excluded = computeVariantExclusions({
      mode: "cap-zero-only",
      facilityCaps: new Map(),
    });
    expect(excluded.has(DEFAULT_VARIANT)).toBe(true);
    expect(excluded.has(TOGGLED_VARIANT)).toBe(true);
  });

  test("cap = 0 excludes both variants", () => {
    const excluded = computeVariantExclusions({
      mode: "cap-zero-only",
      facilityCaps: new Map([[LCG1, 0]]),
    });
    expect(excluded.has(DEFAULT_VARIANT)).toBe(true);
    expect(excluded.has(TOGGLED_VARIANT)).toBe(true);
  });

  test("cap > 0 excludes nothing (defers to LP lex objective)", () => {
    const excluded = computeVariantExclusions({
      mode: "cap-zero-only",
      facilityCaps: new Map([[LCG1, 3]]),
    });
    expect(excluded.size).toBe(0);
  });

  test("fractional positive cap excludes nothing", () => {
    // The aggregation in App.tsx is integer-valued (one Inlet = +1),
    // but the helper shouldn't assume it; any cap > 0 is "available".
    const excluded = computeVariantExclusions({
      mode: "cap-zero-only",
      facilityCaps: new Map([[LCG1, 0.5]]),
    });
    expect(excluded.size).toBe(0);
  });
});

describe("computeVariantExclusions — structure-aware mode", () => {
  test("no available instances excludes both variants", () => {
    const excluded = computeVariantExclusions({
      mode: "structure-aware",
      availableInstances: new Set(),
      toggledFacilities: new Set(),
    });
    expect(excluded.has(DEFAULT_VARIANT)).toBe(true);
    expect(excluded.has(TOGGLED_VARIANT)).toBe(true);
  });

  test("instance available, no toggle: excludes only the toggled variant", () => {
    const excluded = computeVariantExclusions({
      mode: "structure-aware",
      availableInstances: new Set([LCG1]),
      toggledFacilities: new Set(),
    });
    expect(excluded.has(DEFAULT_VARIANT)).toBe(false);
    expect(excluded.has(TOGGLED_VARIANT)).toBe(true);
    expect(excluded.size).toBe(1);
  });

  test("instance available + toggle on: excludes only the default variant", () => {
    const excluded = computeVariantExclusions({
      mode: "structure-aware",
      availableInstances: new Set([LCG1]),
      toggledFacilities: new Set([LCG1]),
    });
    expect(excluded.has(DEFAULT_VARIANT)).toBe(true);
    expect(excluded.has(TOGGLED_VARIANT)).toBe(false);
    expect(excluded.size).toBe(1);
  });

  test("degenerate: toggle on without instance excludes both", () => {
    // The Settings UI cascade prevents this state in practice
    // (enabling the Byproduct Outlet pulls in the inlets via
    // `requires`), but the helper is the structural backstop. Without
    // a physical building, neither variant is selectable regardless
    // of toggle state.
    const excluded = computeVariantExclusions({
      mode: "structure-aware",
      availableInstances: new Set(),
      toggledFacilities: new Set([LCG1]),
    });
    expect(excluded.has(DEFAULT_VARIANT)).toBe(true);
    expect(excluded.has(TOGGLED_VARIANT)).toBe(true);
  });

  test("non-variant facility in availableInstances is ignored", () => {
    // The helper iterates `facilityRecipeVariants` — extra facility
    // ids in `availableInstances` (e.g. AIC-unlocked facilities that
    // happen to share the set) don't matter.
    const excluded = computeVariantExclusions({
      mode: "structure-aware",
      availableInstances: new Set([FacilityId.LIQUID_CLEANER_1, LCG1]),
      toggledFacilities: new Set(),
    });
    expect(excluded.has(TOGGLED_VARIANT)).toBe(true);
    expect(excluded.size).toBe(1);
  });
});

describe("computeVariantExclusions — invariants", () => {
  test("returns a fresh Set on each call (caller may freely mutate)", () => {
    const a = computeVariantExclusions({ mode: "cap-zero-only" });
    const b = computeVariantExclusions({ mode: "cap-zero-only" });
    expect(a).not.toBe(b);
  });

  test("all excluded ids belong to facilityRecipeVariants entries", () => {
    const allVariantIds = new Set<RecipeId>();
    for (const variants of facilityRecipeVariants.values()) {
      allVariantIds.add(variants.default);
      allVariantIds.add(variants.toggled);
    }
    // Pick a config that excludes maximally (no instances, no caps).
    const excluded = computeVariantExclusions({
      mode: "structure-aware",
      availableInstances: new Set(),
      toggledFacilities: new Set(),
    });
    for (const id of excluded) {
      expect(allVariantIds.has(id)).toBe(true);
    }
    // And the same in cap-zero-only mode.
    const excluded2 = computeVariantExclusions({ mode: "cap-zero-only" });
    for (const id of excluded2) {
      expect(allVariantIds.has(id)).toBe(true);
    }
  });
});
