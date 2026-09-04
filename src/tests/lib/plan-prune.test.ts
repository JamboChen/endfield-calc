/**
 * Tests for the plan auto-prune decision (`src/lib/plan-prune.ts`).
 *
 * Two things are being protected here:
 *
 *   1. The onboarding gate. The pre-onboarding defaults deactivate every
 *      non-pinned domain, so they are STRICTER than the all-checked
 *      default the first-visit dialog is about to apply. Pruning against
 *      them deletes targets the user is one click away from being able to
 *      build, irreversibly. The gate must hold until onboarding is
 *      answered, and must release immediately afterwards.
 *   2. The survival rules, which are subtler than they look — notably
 *      that a Metastorage-importable item is honourable with no local
 *      producer, and that a manual raw survives on any of three grounds.
 *
 * Synthetic ids throughout: the rules are set-membership logic and don't
 * depend on real game data.
 */

import { describe, expect, test } from "vitest";

import { computePlanPrune } from "@/lib/plan-prune";
import type { PruneContext, PrunablePlan } from "@/lib/plan-prune";
import type { ItemId, RecipeId } from "@/types";

const item = (s: string) => s as ItemId;
const recipe = (s: string) => s as RecipeId;

const STEEL = item("item_steel");
const GLASS = item("item_glass");
const IMPORTED = item("item_imported");
const ORE = item("item_ore");
const ORPHAN = item("item_orphan");

const STEEL_RECIPE = recipe("recipe_steel");
const DEAD_RECIPE = recipe("recipe_dead");

/** Plan with one of everything, all of it currently honourable. */
function plan(overrides: Partial<PrunablePlan> = {}): PrunablePlan {
  return {
    targets: [{ itemId: STEEL, rate: 6 }],
    recipeOverrides: new Map([[STEEL, STEEL_RECIPE]]),
    manualRawMaterials: new Set([ORE]),
    ...overrides,
  };
}

/** Settings that can honour everything in `plan()`. */
function context(overrides: Partial<PruneContext> = {}): PruneContext {
  return {
    onboardingPending: false,
    reachableProducibleItems: new Set([STEEL, GLASS]),
    availableRecipeIds: new Set([STEEL_RECIPE]),
    metastorageImportableItems: new Set([IMPORTED]),
    regionRawMaterials: new Set([ORE]),
    ...overrides,
  };
}

describe("onboarding gate", () => {
  // A plan that would be gutted: nothing is producible, the pin is dead,
  // the raw has no source.
  const doomed = plan({
    targets: [{ itemId: STEEL, rate: 6 }],
    recipeOverrides: new Map([[STEEL, DEAD_RECIPE]]),
    manualRawMaterials: new Set([ORPHAN]),
  });
  const strict = context({
    reachableProducibleItems: new Set<ItemId>(),
    availableRecipeIds: new Set<RecipeId>(),
    metastorageImportableItems: new Set<ItemId>(),
    regionRawMaterials: new Set<ItemId>(),
  });

  test("nothing is pruned while onboarding is unanswered", () => {
    expect(
      computePlanPrune(doomed, { ...strict, onboardingPending: true }),
    ).toBeNull();
  });

  test("the same plan IS pruned once onboarding is answered", () => {
    // Proves the gate is what held it, not the inputs.
    const result = computePlanPrune(doomed, {
      ...strict,
      onboardingPending: false,
    });
    expect(result).not.toBeNull();
    expect(result!.removedTargets).toBe(1);
    expect(result!.removedOverrides).toBe(1);
    expect(result!.removedRaws).toBe(1);
    expect(result!.total).toBe(3);
  });

});

describe("targets", () => {
  test("a producible target survives", () => {
    expect(computePlanPrune(plan(), context())).toBeNull();
  });

  test("a target nothing can produce is dropped", () => {
    const result = computePlanPrune(
      plan({ targets: [{ itemId: ORPHAN, rate: 6 }] }),
      context(),
    );
    expect(result!.targets).toEqual([]);
    expect(result!.removedTargets).toBe(1);
  });

  test("a Metastorage-importable target survives with no local producer", () => {
    // The subtle rule: importable is a legitimate source, so the item
    // being absent from `reachableProducibleItems` is not enough to drop it.
    const result = computePlanPrune(
      plan({
        targets: [{ itemId: IMPORTED, rate: 6 }],
        recipeOverrides: new Map(),
        manualRawMaterials: new Set(),
      }),
      context(),
    );
    expect(result).toBeNull();
  });

  test("that target IS dropped once its route is disabled", () => {
    const result = computePlanPrune(
      plan({
        targets: [{ itemId: IMPORTED, rate: 6 }],
        recipeOverrides: new Map(),
        manualRawMaterials: new Set(),
      }),
      context({ metastorageImportableItems: new Set<ItemId>() }),
    );
    expect(result!.removedTargets).toBe(1);
  });

  test("surviving targets keep their order and fields", () => {
    const result = computePlanPrune(
      plan({
        targets: [
          { itemId: STEEL, rate: 6, locked: true },
          { itemId: ORPHAN, rate: 1 },
          { itemId: GLASS, rate: 3 },
        ],
      }),
      context(),
    );
    expect(result!.targets).toEqual([
      { itemId: STEEL, rate: 6, locked: true },
      { itemId: GLASS, rate: 3 },
    ]);
  });
});

describe("recipe pins", () => {
  test("a pin on an unavailable recipe is dropped", () => {
    const result = computePlanPrune(
      plan({ recipeOverrides: new Map([[STEEL, DEAD_RECIPE]]) }),
      context(),
    );
    expect(result!.recipeOverrides.size).toBe(0);
    expect(result!.removedOverrides).toBe(1);
  });

  test("only the dead pin goes", () => {
    const result = computePlanPrune(
      plan({
        recipeOverrides: new Map([
          [STEEL, STEEL_RECIPE],
          [GLASS, DEAD_RECIPE],
        ]),
      }),
      context(),
    );
    expect([...result!.recipeOverrides]).toEqual([[STEEL, STEEL_RECIPE]]);
  });
});

describe("manual raws — survives on any of three grounds", () => {
  const bare = { targets: [], recipeOverrides: new Map() };

  test("kept when producible", () => {
    expect(
      computePlanPrune(
        { ...bare, manualRawMaterials: new Set([STEEL]) },
        context({ regionRawMaterials: new Set<ItemId>() }),
      ),
    ).toBeNull();
  });

  test("kept when a regional raw", () => {
    expect(
      computePlanPrune({ ...bare, manualRawMaterials: new Set([ORE]) }, context()),
    ).toBeNull();
  });

  test("kept when Metastorage-importable", () => {
    expect(
      computePlanPrune(
        { ...bare, manualRawMaterials: new Set([IMPORTED]) },
        context(),
      ),
    ).toBeNull();
  });

  test("dropped only when unsourceable on all three", () => {
    const result = computePlanPrune(
      { ...bare, manualRawMaterials: new Set([ORPHAN]) },
      context(),
    );
    expect(result!.manualRawMaterials.size).toBe(0);
    expect(result!.removedRaws).toBe(1);
  });
});

describe("caller contract", () => {
  test("a fully honourable plan returns null (no spurious toast)", () => {
    expect(computePlanPrune(plan(), context())).toBeNull();
  });

  test("an empty plan returns null", () => {
    expect(
      computePlanPrune(
        {
          targets: [],
          recipeOverrides: new Map(),
          manualRawMaterials: new Set(),
        },
        context(),
      ),
    ).toBeNull();
  });

  test("idempotent — re-running on the result returns null", () => {
    // This is what stops the caller's state writes from re-entering the
    // effect and firing a second toast.
    const doomed = plan({
      targets: [
        { itemId: STEEL, rate: 6 },
        { itemId: ORPHAN, rate: 1 },
      ],
      recipeOverrides: new Map([[GLASS, DEAD_RECIPE]]),
      manualRawMaterials: new Set([ORPHAN]),
    });
    const first = computePlanPrune(doomed, context());
    expect(first!.total).toBe(3);
    expect(computePlanPrune(first!, context())).toBeNull();
  });

  test("the result's collections are fresh, not the inputs", () => {
    // The caller hands them straight to state setters, so aliasing the
    // input would mutate live state.
    const input = plan({
      targets: [
        { itemId: STEEL, rate: 6 },
        { itemId: ORPHAN, rate: 1 },
      ],
      recipeOverrides: new Map([[GLASS, DEAD_RECIPE]]),
      manualRawMaterials: new Set([ORPHAN]),
    });
    const result = computePlanPrune(input, context())!;
    expect(result.targets).not.toBe(input.targets);
    expect(result.recipeOverrides).not.toBe(input.recipeOverrides);
    expect(result.manualRawMaterials).not.toBe(input.manualRawMaterials);
    // Inputs untouched.
    expect(input.targets).toHaveLength(2);
    expect(input.recipeOverrides.size).toBe(1);
    expect(input.manualRawMaterials.size).toBe(1);
  });
});
