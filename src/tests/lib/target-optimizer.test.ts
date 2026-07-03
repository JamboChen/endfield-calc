import { describe, test, expect } from "vitest";
import { rawsInChainOf } from "@/lib/target-optimizer";
import { recipes } from "@/data";
import { ItemId as ItemIdEnum } from "@/types/constants";
import type { ItemId, Recipe, FacilityId, RecipeId } from "@/types";
import { ALL_RAWS } from "./utils";

/** Terse synthetic-recipe builder (tests only — casts are fine here). */
function recipe(
  id: string,
  inputs: [string, number][],
  outputs: [string, number][],
): Recipe {
  return {
    id: id as RecipeId,
    inputs: inputs.map(([itemId, amount]) => ({
      itemId: itemId as ItemId,
      amount,
    })),
    outputs: outputs.map(([itemId, amount]) => ({
      itemId: itemId as ItemId,
      amount,
    })),
    facilityId: "synth_facility" as FacilityId,
    craftingTime: 2,
  };
}

const raws = (...ids: string[]) => new Set(ids.map((i) => i as ItemId));

describe("rawsInChainOf (Max-button gating closure)", () => {
  test("linear chain: raw → mid → final resolves the root raw", () => {
    const rs = [
      recipe("r_mid", [["raw_a", 1]], [["mid", 1]]),
      recipe("r_final", [["mid", 2]], [["final", 1]]),
    ];
    const result = rawsInChainOf("final" as ItemId, rs, raws("raw_a"));
    expect(result).toEqual(raws("raw_a"));
  });

  test("alternative producers: all branches contribute their raws", () => {
    // `final` can be made from raw_a OR raw_b — the closure walks every
    // alternative producer (mirrors the graph builder's no-single-pick
    // philosophy), so both raws gate the Max button.
    const rs = [
      recipe("r_a", [["raw_a", 1]], [["final", 1]]),
      recipe("r_b", [["raw_b", 1]], [["final", 1]]),
    ];
    const result = rawsInChainOf(
      "final" as ItemId,
      rs,
      raws("raw_a", "raw_b"),
    );
    expect(result).toEqual(raws("raw_a", "raw_b"));
  });

  test("cycles terminate: planter ↔ seed loop with a raw feed", () => {
    // planter: seed + water → plant; seedmaker: plant → seed.
    // The plant↔seed cycle must not loop forever; water is the only raw.
    const rs = [
      recipe(
        "r_plant",
        [
          ["seed", 1],
          ["raw_water", 1],
        ],
        [["plant", 1]],
      ),
      recipe("r_seed", [["plant", 1]], [["seed", 2]]),
    ];
    const result = rawsInChainOf("plant" as ItemId, rs, raws("raw_water"));
    expect(result).toEqual(raws("raw_water"));
  });

  test("raws terminate their branch even when a recipe emits them", () => {
    // A recipe that outputs raw_a as a byproduct must not pull raw_a's
    // own inputs into the closure — raws are sourced from pickup
    // points, so the cap applies regardless of any producer.
    const rs = [
      recipe("r_weird", [["raw_b", 1]], [["raw_a", 1]]),
      recipe("r_final", [["raw_a", 1]], [["final", 1]]),
    ];
    const result = rawsInChainOf(
      "final" as ItemId,
      rs,
      raws("raw_a", "raw_b"),
    );
    // raw_a terminates; raw_b (only reachable THROUGH raw_a's producer)
    // is not part of the chain.
    expect(result).toEqual(raws("raw_a"));
  });

  test("item with no producers and not raw → empty set", () => {
    const result = rawsInChainOf("orphan" as ItemId, [], raws("raw_a"));
    expect(result.size).toBe(0);
  });

  test("unreachable raws are excluded", () => {
    const rs = [
      recipe("r_final", [["raw_a", 1]], [["final", 1]]),
      recipe("r_other", [["raw_b", 1]], [["other", 1]]),
    ];
    const result = rawsInChainOf(
      "final" as ItemId,
      rs,
      raws("raw_a", "raw_b"),
    );
    expect(result).toEqual(raws("raw_a"));
  });

  test("real data: Cuprium Part chain = exactly {water, copper ore}", () => {
    const result = rawsInChainOf(
      ItemIdEnum.ITEM_COPPER_CMPT,
      recipes,
      ALL_RAWS,
    );
    expect(result).toEqual(
      new Set([ItemIdEnum.ITEM_LIQUID_WATER, ItemIdEnum.ITEM_COPPER_ORE]),
    );
  });

  test("real data: Xiranite Poly chain reaches water; only raws returned", () => {
    const result = rawsInChainOf(
      ItemIdEnum.ITEM_XIRANITE_POLY,
      recipes,
      ALL_RAWS,
    );
    expect(result.has(ItemIdEnum.ITEM_LIQUID_WATER)).toBe(true);
    expect(result.size).toBeGreaterThan(0);
    // Every returned id must actually be a raw.
    for (const id of result) {
      expect(ALL_RAWS.has(id)).toBe(true);
    }
  });
});
