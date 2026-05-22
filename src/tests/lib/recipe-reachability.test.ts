/**
 * Unit tests for `computeRecipeReachability`.
 *
 * Synthetic recipes with branded-cast IDs. Pure data tests — no
 * calculator integration. End-to-end behavior (App-layer composition
 * of AIC + chain filters → calc input) is covered by integration
 * tests in `aic-integration.test.ts`.
 */

import { describe, test, expect } from "vitest";

import { computeRecipeReachability } from "@/lib/recipe-reachability";
import type { ItemId, Recipe, RecipeId, FacilityId } from "@/types";

const recipe = (
  id: string,
  inputs: string[],
  outputs: string[],
  facilityId = "fac",
  craftingTime = 1,
): Recipe => ({
  id: id as RecipeId,
  inputs: inputs.map((itemId) => ({ itemId: itemId as ItemId, amount: 1 })),
  outputs: outputs.map((itemId) => ({ itemId: itemId as ItemId, amount: 1 })),
  facilityId: facilityId as FacilityId,
  craftingTime,
});

const rawSet = (...ids: string[]): ReadonlySet<ItemId> =>
  new Set(ids.map((s) => s as ItemId));

describe("computeRecipeReachability", () => {
  test("empty input yields empty output", () => {
    const result = computeRecipeReachability([], new Set());
    expect(result.reachableItems.size).toBe(0);
    expect(result.runnableRecipes).toHaveLength(0);
    expect(result.blockedRecipes).toHaveLength(0);
  });

  test("all recipes runnable when their inputs are raws", () => {
    const r1 = recipe("r1", ["raw_a"], ["intermediate"]);
    const r2 = recipe("r2", ["raw_b"], ["other"]);
    const result = computeRecipeReachability(
      [r1, r2],
      rawSet("raw_a", "raw_b"),
    );
    expect(result.runnableRecipes.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(result.blockedRecipes).toHaveLength(0);
    expect(result.reachableItems.has("intermediate" as ItemId)).toBe(true);
    expect(result.reachableItems.has("other" as ItemId)).toBe(true);
  });

  test("multi-step chain: A produces X, B consumes X — both runnable when A's input is raw", () => {
    const a = recipe("a", ["raw"], ["x"]);
    const b = recipe("b", ["x"], ["y"]);
    const result = computeRecipeReachability([a, b], rawSet("raw"));
    expect(result.runnableRecipes.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.reachableItems.has("x" as ItemId)).toBe(true);
    expect(result.reachableItems.has("y" as ItemId)).toBe(true);
  });

  test("single recipe blocked when its sole input has no producer and isn't a raw", () => {
    // Mimics: Furnace locked, xiranite_oven_xiranite_powder_1 needs
    // item_carbon_enr which isn't a raw and has no producer.
    const r = recipe("xiranite_powder", ["carbon_enr"], ["xiranite_powder"]);
    const result = computeRecipeReachability([r], rawSet());
    expect(result.runnableRecipes).toHaveLength(0);
    expect(result.blockedRecipes.map((x) => x.id)).toEqual(["xiranite_powder"]);
    expect(result.reachableItems.has("xiranite_powder" as ItemId)).toBe(false);
  });

  test("cascade: A→B→C all blocked when A's input is missing", () => {
    const a = recipe("a", ["missing"], ["x"]);
    const b = recipe("b", ["x"], ["y"]);
    const c = recipe("c", ["y"], ["z"]);
    const result = computeRecipeReachability([a, b, c], rawSet());
    expect(result.runnableRecipes).toHaveLength(0);
    expect(result.blockedRecipes.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("partial cascade: A produces X but B needs unrelated missing input — A runnable, B blocked", () => {
    const a = recipe("a", ["raw"], ["x"]);
    const b = recipe("b", ["missing"], ["y"]);
    const result = computeRecipeReachability([a, b], rawSet("raw"));
    expect(result.runnableRecipes.map((r) => r.id)).toEqual(["a"]);
    expect(result.blockedRecipes.map((r) => r.id)).toEqual(["b"]);
    expect(result.reachableItems.has("x" as ItemId)).toBe(true);
    expect(result.reachableItems.has("y" as ItemId)).toBe(false);
  });

  test("disposal recipe (0 outputs) with reachable input is runnable", () => {
    const producer = recipe("producer", ["raw"], ["waste"]);
    const disposal = recipe("disposal", ["waste"], []); // no outputs
    const result = computeRecipeReachability(
      [producer, disposal],
      rawSet("raw"),
    );
    expect(result.runnableRecipes.map((r) => r.id)).toEqual([
      "producer",
      "disposal",
    ]);
    expect(result.reachableItems.has("waste" as ItemId)).toBe(true);
    // Disposal didn't add new items — only consumed.
  });

  test("2-cycle without external entry: both recipes blocked", () => {
    // A consumes X, produces Y. B consumes Y, produces X. Neither X
    // nor Y is a raw or external. The closure can't seed either —
    // both blocked.
    const a = recipe("a", ["x"], ["y"]);
    const b = recipe("b", ["y"], ["x"]);
    const result = computeRecipeReachability([a, b], rawSet());
    expect(result.runnableRecipes).toHaveLength(0);
    expect(result.blockedRecipes.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("2-cycle WITH external entry (a raw seeds X) — both runnable", () => {
    // Same cycle as above but X is a raw → cycle bootstraps.
    const a = recipe("a", ["x"], ["y"]);
    const b = recipe("b", ["y"], ["x"]);
    const result = computeRecipeReachability([a, b], rawSet("x"));
    expect(result.runnableRecipes.map((r) => r.id).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  test("manual-raw style: passing additional raws expands the closure", () => {
    // Same scenario as "single recipe blocked" but with carbon_enr
    // included in rawMaterials. Confirms the helper is pure — it
    // honors whatever raw set is passed in. (The App layer chooses
    // to pass forcedRawMaterials only; this test confirms the
    // helper's contract, not the app policy.)
    const r = recipe("xiranite_powder", ["carbon_enr"], ["xiranite_powder"]);
    const withCarbonAsRaw = computeRecipeReachability(
      [r],
      rawSet("carbon_enr"),
    );
    expect(withCarbonAsRaw.runnableRecipes.map((x) => x.id)).toEqual([
      "xiranite_powder",
    ]);
    expect(withCarbonAsRaw.blockedRecipes).toHaveLength(0);
  });

  test("recipe with 0 inputs is vacuously runnable", () => {
    // Edge case: no inputs → all-inputs-reachable is vacuously true.
    // Today no real recipe has zero inputs, but a future patch might.
    const r = recipe("genesis", [], ["out"]);
    const result = computeRecipeReachability([r], rawSet());
    expect(result.runnableRecipes.map((x) => x.id)).toEqual(["genesis"]);
    expect(result.reachableItems.has("out" as ItemId)).toBe(true);
  });

  test("input order preserved in runnableRecipes and blockedRecipes", () => {
    // Determinism: the output filters the input array in place.
    const recipes = [
      recipe("a", ["raw"], ["x"]),
      recipe("b", ["missing"], ["y"]),
      recipe("c", ["x"], ["z"]),
    ];
    const result = computeRecipeReachability(recipes, rawSet("raw"));
    expect(result.runnableRecipes.map((r) => r.id)).toEqual(["a", "c"]);
    expect(result.blockedRecipes.map((r) => r.id)).toEqual(["b"]);
  });
});
