/**
 * Tests for `rawAvailabilityByDomain` and its integration with the
 * per-region recipe reachability filter.
 *
 * Four layers of coverage:
 *
 *   1. **Data shape** — exact-set snapshot of each region's expected
 *      raws. Catches accidental edits to `src/data/index.ts`.
 *
 *   2. **Invariants** vs `rawMaterialSources`:
 *      a. **Soundness** — every per-region raw has a `rawMaterialSources`
 *         entry. Catches the case where someone adds a raw to a region
 *         without binding it to a source facility.
 *      b. **Completeness** — every `rawMaterialSources` key appears in
 *         at least one region. Catches the future-patch drift where a
 *         new raw is added to the source-facility map but no region
 *         lists it as available, silently making it unreachable
 *         everywhere.
 *      c. **Coverage** — every domain in the registry has an entry
 *         here, so `App.tsx`'s `rawAvailabilityByDomain.get(currentDomain)!`
 *         is safe.
 *
 *   3. **Drift detection** — liquid availability in
 *      `rawAvailabilityByDomain` is gated by the source pump's
 *      `Facility.domains`. If pumps move regions in a future schema
 *      refresh, this test fails until the data is updated.
 *
 *   4. **Reachability integration** — full-pipeline tests against the
 *      real game data: a Cuprium-dependent target (and a transitively-
 *      Cuprium-dependent target) become unreachable when planning in
 *      Valley IV; symmetric for Amethyst in Wuling; bbflower planter
 *      (no liquid) stays reachable in Valley IV.
 */

import { describe, test, expect } from "vitest";
import {
  facilities,
  items,
  rawAvailabilityByDomain,
  rawMaterialSources,
  recipes,
  bootstrapFacilities,
} from "@/data";
import { domains } from "@/data/aic-plans";
import { computeRecipeReachability } from "@/lib/recipe-reachability";
import { DomainId } from "@/types/domain";
import { ItemId } from "@/types/constants";

const DOMAIN_1 = DomainId.DOMAIN_1;
const DOMAIN_2 = DomainId.DOMAIN_2;

describe("rawAvailabilityByDomain — data shape", () => {
  test("Valley IV (domain_1) contains exactly the 3 solid raws", () => {
    const valleySet = rawAvailabilityByDomain.get(DOMAIN_1);
    expect(valleySet).toBeDefined();
    expect(valleySet).toEqual(
      new Set<ItemId>([
        ItemId.ITEM_ORIGINIUM_ORE,
        ItemId.ITEM_IRON_ORE,
        ItemId.ITEM_QUARTZ_SAND,
      ]),
    );
  });

  test("Wuling (domain_2) contains 3 solid raws + 2 liquid raws", () => {
    const wulingSet = rawAvailabilityByDomain.get(DOMAIN_2);
    expect(wulingSet).toBeDefined();
    expect(wulingSet).toEqual(
      new Set<ItemId>([
        ItemId.ITEM_ORIGINIUM_ORE,
        ItemId.ITEM_IRON_ORE,
        ItemId.ITEM_COPPER_ORE,
        ItemId.ITEM_LIQUID_WATER,
        ItemId.ITEM_LIQUID_ACID,
      ]),
    );
  });
});

describe("rawAvailabilityByDomain — invariants vs rawMaterialSources", () => {
  test("soundness: every per-region raw has a rawMaterialSources entry", () => {
    // A raw that appears in a region but has no source-facility binding
    // is unsourceable in practice; the data layer would render this
    // broken state.
    for (const [, set] of rawAvailabilityByDomain) {
      for (const itemId of set) {
        expect(rawMaterialSources.has(itemId)).toBe(true);
      }
    }
  });

  test("completeness: every raw in rawMaterialSources appears in at least one region", () => {
    // Catches the future-patch drift case: a new raw added to
    // rawMaterialSources but no region lists it as available — the
    // raw would be unreachable everywhere, silently. The completeness
    // invariant forces the data author to map it to at least one
    // region (or remove the source-facility binding).
    const union = new Set<ItemId>();
    for (const [, set] of rawAvailabilityByDomain) {
      for (const itemId of set) union.add(itemId);
    }
    for (const itemId of rawMaterialSources.keys()) {
      expect(union.has(itemId)).toBe(true);
    }
  });

  test("coverage: every domain in the registry has an entry here", () => {
    // App.tsx uses `rawAvailabilityByDomain.get(currentDomain)!`
    // (non-null assertion) — this invariant makes the assertion safe.
    // If a new domain is added to `domains` without a corresponding
    // entry here, this test fails before the non-null bites users.
    for (const d of domains) {
      expect(rawAvailabilityByDomain.has(d.id)).toBe(true);
    }
  });
});

describe("rawAvailabilityByDomain — drift detection", () => {
  test("liquid availability matches pump source-facility Facility.domains", () => {
    // For each liquid raw, the regions where it appears in
    // `rawAvailabilityByDomain` must match the regions where its source
    // pump can be placed (`Facility.domains` empty = anywhere; otherwise
    // the listed domains). Drift fails the test loudly so the data stays
    // in sync without runtime derivation.
    for (const item of items) {
      if (item.isLiquid !== true) continue;
      const cfg = rawMaterialSources.get(item.id);
      if (!cfg) continue;
      const facility = facilities.find((f) => f.id === cfg.sourceFacility);
      if (!facility) continue;

      const facilityIsUnrestricted = facility.domains.length === 0;

      for (const [domainId, rawSet] of rawAvailabilityByDomain) {
        const isInRawSet = rawSet.has(item.id);
        const facilityAllowsDomain =
          facilityIsUnrestricted ||
          facility.domains.includes(domainId);
        expect(
          isInRawSet,
          `liquid raw ${item.id}: expected isInRawSet=${facilityAllowsDomain} ` +
            `for domain ${domainId} (facility ${facility.id}.domains=` +
            `[${facility.domains.join(",")}])`,
        ).toBe(facilityAllowsDomain);
      }
    }
  });
});

describe("rawAvailabilityByDomain — reachability integration", () => {
  test("Cuprium ore is unreachable in Valley IV; reachable in Wuling", () => {
    const valleyRaws = rawAvailabilityByDomain.get(DOMAIN_1)!;
    const wulingRaws = rawAvailabilityByDomain.get(DOMAIN_2)!;

    const valley = computeRecipeReachability(
      recipes,
      valleyRaws,
      bootstrapFacilities,
    );
    const wuling = computeRecipeReachability(
      recipes,
      wulingRaws,
      bootstrapFacilities,
    );

    // The raw itself only appears in `reachableItems` when it's in the
    // root raw set. Valley IV's set lacks Cuprium → it's not reachable.
    expect(valley.reachableItems.has(ItemId.ITEM_COPPER_ORE)).toBe(false);
    expect(wuling.reachableItems.has(ItemId.ITEM_COPPER_ORE)).toBe(true);
  });

  test("Amethyst (quartz sand) is unreachable in Wuling; reachable in Valley IV", () => {
    const valleyRaws = rawAvailabilityByDomain.get(DOMAIN_1)!;
    const wulingRaws = rawAvailabilityByDomain.get(DOMAIN_2)!;

    const valley = computeRecipeReachability(
      recipes,
      valleyRaws,
      bootstrapFacilities,
    );
    const wuling = computeRecipeReachability(
      recipes,
      wulingRaws,
      bootstrapFacilities,
    );

    expect(valley.reachableItems.has(ItemId.ITEM_QUARTZ_SAND)).toBe(true);
    expect(wuling.reachableItems.has(ItemId.ITEM_QUARTZ_SAND)).toBe(false);
  });

  test("transitively-Cuprium-dependent target (Copper Cmpt) is unreachable in Valley IV", () => {
    // item_copper_cmpt is produced by `component_copper_cmpt_1` which
    // consumes copper_enr (← copper powder ← copper nugget ← copper_ore).
    // Without Cuprium ore in the raw set, the chain breaks at the
    // furnace input → component_copper_cmpt_1 isn't runnable → Copper
    // Cmpt isn't reachable.
    const valleyRaws = rawAvailabilityByDomain.get(DOMAIN_1)!;
    const wulingRaws = rawAvailabilityByDomain.get(DOMAIN_2)!;

    const valley = computeRecipeReachability(
      recipes,
      valleyRaws,
      bootstrapFacilities,
    );
    const wuling = computeRecipeReachability(
      recipes,
      wulingRaws,
      bootstrapFacilities,
    );

    expect(valley.reachableItems.has(ItemId.ITEM_COPPER_CMPT)).toBe(false);
    expect(wuling.reachableItems.has(ItemId.ITEM_COPPER_CMPT)).toBe(true);

    // Also pin the failure-chain assumption: the canonical producer
    // `component_copper_cmpt_1` must be non-runnable in Valley IV
    // (because its inputs trace back to Cuprium). If a future patch
    // adds an alternative producer that doesn't need Cuprium, this
    // would silently flip and the reachableItems assertion above
    // would still pass for the wrong reason.
    expect(
      valley.runnableRecipes.some((r) => r.id === "component_copper_cmpt_1"),
    ).toBe(false);
    expect(
      wuling.runnableRecipes.some((r) => r.id === "component_copper_cmpt_1"),
    ).toBe(true);
  });

  test("Buckflower planter recipe (no liquid input) stays reachable in Valley IV", () => {
    // `planter_plant_bbflower_1` consumes only a seed (recipe-internal
    // bootstrap; planter_1 is on `bootstrapFacilities`), so it doesn't
    // require any liquid. It must remain reachable in Valley IV
    // despite liquids being absent from the region's raw set.
    const valleyRaws = rawAvailabilityByDomain.get(DOMAIN_1)!;
    const valley = computeRecipeReachability(
      recipes,
      valleyRaws,
      bootstrapFacilities,
    );
    expect(valley.runnableRecipes.some((r) => r.id === "planter_plant_bbflower_1")).toBe(true);
    expect(valley.reachableItems.has(ItemId.ITEM_PLANT_BBFLOWER_1)).toBe(true);
  });

  test("water-consuming recipes are gated in Valley IV (no liquid sourceable)", () => {
    // `planter_plant_grass_1_1` consumes water (liquid mode on planter).
    // Without water in Valley IV's raw set, this recipe isn't runnable.
    const valleyRaws = rawAvailabilityByDomain.get(DOMAIN_1)!;
    const wulingRaws = rawAvailabilityByDomain.get(DOMAIN_2)!;

    const valley = computeRecipeReachability(
      recipes,
      valleyRaws,
      bootstrapFacilities,
    );
    const wuling = computeRecipeReachability(
      recipes,
      wulingRaws,
      bootstrapFacilities,
    );

    expect(valley.runnableRecipes.some((r) => r.id === "planter_plant_grass_1_1")).toBe(false);
    expect(wuling.runnableRecipes.some((r) => r.id === "planter_plant_grass_1_1")).toBe(true);
  });
});
