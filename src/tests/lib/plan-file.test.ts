/**
 * Tests for the saved-plan file format (`src/lib/plan-file.ts`).
 *
 * The load path is the one place a user's own file can turn into a
 * confusing app state, so most of this covers damage: files from an
 * older version, hand-edited ones, and ids the game data no longer has.
 *
 * The rule that matters most is in `readSavedSettings` — a settings
 * block that fails validation must read as ABSENT, never as "valid, all
 * default". The default shape is the pre-onboarding world, so the
 * difference is between "load against your own settings" and "silently
 * enter read-only shared-view against a crippled region set".
 */

import { describe, expect, test } from "vitest";

import {
  buildSavedPlan,
  readSavedSettings,
  savedPlanToHashState,
  type SavedPlan,
} from "@/lib/plan-file";
import { DEFAULT_PLAN_OPTIONS } from "@/lib/plan-options-storage";
import { DEFAULT_PERSISTED_SHAPE } from "@/lib/persisted-shape";
import { items, recipes } from "@/data";
import { DomainId } from "@/types/domain";

const someItem = items[0].id;
const otherItem = items[1].id;
const someRecipe = recipes[0].id;

function file(overrides: Partial<SavedPlan> = {}): SavedPlan {
  return {
    version: "1",
    targets: [{ itemId: someItem, rate: 6 }],
    recipeOverrides: {},
    manualRawMaterials: [],
    ceilMode: false,
    ...overrides,
  };
}

describe("readSavedSettings — damage must read as absent", () => {
  test("a file with no settings block", () => {
    expect(readSavedSettings(file())).toBeNull();
  });

  test("a valid settings block survives", () => {
    const settings = readSavedSettings(
      file({ settings: DEFAULT_PERSISTED_SHAPE }),
    );
    expect(settings).not.toBeNull();
  });

  test("a corrupt settings block reads as absent, NOT as defaults", () => {
    // The regression: these used to encode as the all-default snapshot,
    // which is the pre-onboarding world (every non-pinned domain
    // inactive) — so opening your own damaged file dropped you into
    // read-only shared-view against a region set you never chose.
    for (const broken of [
      {},
      { aic: "nope" },
      { domains: 42 },
      [],
      "not an object",
      0,
    ]) {
      expect(
        readSavedSettings(file({ settings: broken as never })),
      ).toBeNull();
    }
  });
});

describe("savedPlanToHashState — ids are resolved against the game data", () => {
  test("known ids survive", () => {
    const state = savedPlanToHashState(
      file({
        targets: [{ itemId: someItem, rate: 6, locked: true }],
        recipeOverrides: { [someItem]: someRecipe },
        manualRawMaterials: [otherItem],
      }),
    );
    expect(state.targets).toEqual([{ itemId: someItem, rate: 6, locked: true }]);
    expect([...state.recipeOverrides]).toEqual([[someItem, someRecipe]]);
    expect([...state.manualRawMaterials]).toEqual([otherItem]);
  });

  test("unknown ids are dropped at load, not carried further", () => {
    // Carrying them would make them vanish later — after a reload, via
    // the URL parse — for reasons the user cannot connect to the file.
    const state = savedPlanToHashState(
      file({
        targets: [
          { itemId: "item_does_not_exist", rate: 6 },
          { itemId: someItem, rate: 3 },
        ],
        recipeOverrides: { item_gone: "recipe_gone" },
        manualRawMaterials: ["item_gone"],
      }),
    );
    expect(state.targets).toEqual([{ itemId: someItem, rate: 3 }]);
    expect(state.recipeOverrides.size).toBe(0);
    expect(state.manualRawMaterials.size).toBe(0);
  });

  test("malformed rates are dropped", () => {
    const state = savedPlanToHashState(
      file({
        targets: [
          { itemId: someItem, rate: Number.NaN },
          { itemId: otherItem, rate: -5 },
        ],
      }),
    );
    expect(state.targets).toHaveLength(0);
  });

  test("a legacy file (no option fields) gets the documented defaults", () => {
    const legacy = {
      version: "1",
      targets: [{ itemId: someItem, rate: 6 }],
      recipeOverrides: {},
      manualRawMaterials: [],
      ceilMode: true,
    } as SavedPlan;
    const state = savedPlanToHashState(legacy);
    expect(state.ceilMode).toBe(true);
    expect(state.binFusion).toBe(DEFAULT_PLAN_OPTIONS.binFusion);
    expect(state.powerSustain).toBe(DEFAULT_PLAN_OPTIONS.powerSustain);
    expect(state.machinesPerVaporizer).toBe(
      DEFAULT_PLAN_OPTIONS.machinesPerVaporizer,
    );
  });

  test("an out-of-range coverage ratio is clamped, not trusted", () => {
    expect(
      savedPlanToHashState(file({ machinesPerVaporizer: 999 }))
        .machinesPerVaporizer,
    ).toBe(DEFAULT_PLAN_OPTIONS.machinesPerVaporizer);
  });

  test("missing collections don't throw", () => {
    const sparse = { version: "1", ceilMode: false } as unknown as SavedPlan;
    expect(() => savedPlanToHashState(sparse)).not.toThrow();
    expect(savedPlanToHashState(sparse).targets).toHaveLength(0);
  });
});

describe("build → load round trip", () => {
  test("a saved plan reloads to the same state", () => {
    const state = {
      targets: [
        { itemId: someItem, rate: 14.75, locked: true },
        { itemId: otherItem, rate: 3 },
      ],
      recipeOverrides: new Map([[someItem, someRecipe]]),
      manualRawMaterials: new Set([otherItem]),
      ceilMode: true,
      binFusion: false,
      powerSustain: true,
      machinesPerVaporizer: 9,
    };
    const reloaded = savedPlanToHashState(
      buildSavedPlan(state, DEFAULT_PERSISTED_SHAPE),
    );
    expect(reloaded).toEqual(state);
  });

  test("the settings snapshot rides along", () => {
    const shape = {
      ...DEFAULT_PERSISTED_SHAPE,
      domains: { inactive: [], current: DomainId.DOMAIN_2 },
    };
    const saved = buildSavedPlan(
      {
        targets: [{ itemId: someItem, rate: 6 }],
        recipeOverrides: new Map(),
        manualRawMaterials: new Set(),
        ...DEFAULT_PLAN_OPTIONS,
      },
      shape,
    );
    expect(readSavedSettings(saved)?.domains.current).toBe(DomainId.DOMAIN_2);
  });
});
