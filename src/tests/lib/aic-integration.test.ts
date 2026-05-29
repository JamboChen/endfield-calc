/**
 * End-to-end tests for AIC-driven recipe filtering.
 *
 * Validates that `computeRecipeAvailability` integrates correctly with
 * `calculateProductionPlan`: a target that depends on a locked facility
 * either has its production unreachable (calc treats inputs as raws) or
 * surfaces no producer at all. Also validates that the picker's
 * `targetableItems` derivation matches the recipe-output union.
 *
 * No DOM tests here — those would require @testing-library/react. We
 * exercise the pure data flow that the App layer threads.
 */

import { describe, test, expect } from "vitest";
import { calculateProductionPlan } from "@/lib/calculator";
import {
  computeRecipeAvailability,
  computeUnlockedFacilities,
  computeUnlockedModes,
} from "@/lib/aic-research-helpers";
import { computeRecipeReachability } from "@/lib/recipe-reachability";
import {
  items,
  recipes,
  facilities,
  forcedRawMaterials,
  bootstrapFacilities,
} from "@/data";
import { aicGroups, aicNodes } from "@/data/aic-plans";
import type { AicTechId } from "@/types/aic";
import type { DomainId } from "@/types/domain";
import { FacilityId, ItemId } from "@/types/constants";

/**
 * Helper: derive a fully-unlocked research set from `aicNodes`. Mimics
 * the Step-1 default state ("everything researched").
 */
const allResearched = (): ReadonlySet<AicTechId> =>
  new Set(aicNodes.map((n) => n.id));

/**
 * Helper: derive the active-domains set (both Valley IV + Wuling active).
 */
const allDomainsActive = (): ReadonlySet<DomainId> =>
  new Set(aicGroups.map((g) => g.domainId));

/**
 * Helper: take a fully-researched set and remove specific tech ids
 * (de-researching them). Used to simulate "user has not researched X".
 */
const allButNotResearched = (
  ...excluded: string[]
): ReadonlySet<AicTechId> => {
  const all = allResearched();
  const excludedSet = new Set(excluded);
  const out = new Set<AicTechId>();
  for (const id of all) {
    if (!excludedSet.has(id)) out.add(id);
  }
  return out;
};

describe("AIC integration: recipe availability + calculator", () => {
  test("with all techs researched + all domains active, every game recipe is available", () => {
    const researched = allResearched();
    const activeDomains = allDomainsActive();
    const unlockedFacilities = computeUnlockedFacilities(
      researched,
      activeDomains,
    );
    const unlockedModes = computeUnlockedModes(researched, unlockedFacilities);
    const { availableRecipes, gatedRecipeIds } = computeRecipeAvailability(
      recipes,
      unlockedFacilities,
      unlockedModes,
    );

    expect(availableRecipes).toHaveLength(recipes.length);
    expect(gatedRecipeIds.size).toBe(0);
  });

  test("with only Valley IV active and no Wuling techs, Wuling-gated facilities produce no recipes", () => {
    // Activate Valley IV only; Wuling is inactive → its facilities stay
    // locked unless they're also reachable via Valley IV (none of the
    // Wuling techs share a facility with Valley IV ones today).
    const activeDomains = new Set(["domain_1"] as DomainId[]);
    // Everything researched, but only Valley IV is active. Tests the
    // domain-filter path in computeUnlockedFacilities.
    const unlockedFacilities = computeUnlockedFacilities(
      allResearched(),
      activeDomains,
    );

    // Wuling-specific facilities should NOT be in unlockedFacilities.
    expect(unlockedFacilities.has(FacilityId.MIX_POOL_1)).toBe(false);
    expect(unlockedFacilities.has(FacilityId.MIX_POOL_2)).toBe(false);
    expect(unlockedFacilities.has(FacilityId.DISMANTLER_1)).toBe(false);
    expect(unlockedFacilities.has(FacilityId.PUMP_2)).toBe(false);

    // Valley IV facilities are unlocked.
    expect(unlockedFacilities.has(FacilityId.FURNANCE_1)).toBe(true);
    expect(unlockedFacilities.has(FacilityId.GRINDER_1)).toBe(true);

    const unlockedModes = computeUnlockedModes(allResearched(), unlockedFacilities);
    const { availableRecipes, gatedRecipeIds } = computeRecipeAvailability(
      recipes,
      unlockedFacilities,
      unlockedModes,
    );

    // Every gated recipe must reference a locked facility OR a locked mode.
    expect(gatedRecipeIds.size).toBeGreaterThan(0);
    for (const recipe of recipes) {
      if (gatedRecipeIds.has(recipe.id)) {
        const facilityUnlocked = unlockedFacilities.has(recipe.facilityId);
        if (!facilityUnlocked) {
          // OK — gated because the facility itself is locked.
          continue;
        }
        // Facility unlocked → must be mode-gated. We can't easily assert
        // the mode without re-deriving, so just confirm the recipe isn't
        // in availableRecipes.
        expect(availableRecipes.some((r) => r.id === recipe.id)).toBe(false);
      }
    }
  });

  test("filtering out grinder breaks iron-powder production downstream", async () => {
    // Hypothetical: user un-researches the grinder unlock. The Iron
    // Powder recipe (grinder_iron_powder_1) becomes unavailable, so
    // `calculateProductionPlan` treats item_iron_powder as a raw — no
    // producer recipe is selected.
    const researched = allButNotResearched("tech_tundra_1_grinder_1");
    const activeDomains = allDomainsActive();
    const unlockedFacilities = computeUnlockedFacilities(
      researched,
      activeDomains,
    );
    const unlockedModes = computeUnlockedModes(researched, unlockedFacilities);
    const { availableRecipes } = computeRecipeAvailability(
      recipes,
      unlockedFacilities,
      unlockedModes,
    );

    // The grinder facility is locked.
    expect(unlockedFacilities.has(FacilityId.GRINDER_1)).toBe(false);
    // No grinder recipes in the available set.
    expect(
      availableRecipes.some((r) => r.facilityId === FacilityId.GRINDER_1),
    ).toBe(false);

    // Now calc a plan that NEEDS iron powder. Without a producer recipe,
    // iron powder falls back to raw-material status.
    const plan = await calculateProductionPlan(
      [{ itemId: ItemId.ITEM_IRON_POWDER, rate: 10 }],
      items,
      availableRecipes,
      facilities,
    );

    const powderNode = plan.nodes.get(ItemId.ITEM_IRON_POWDER);
    expect(powderNode).toBeDefined();
    expect(powderNode?.type).toBe("item");
    if (powderNode?.type === "item") {
      // No recipe → fell back to raw.
      expect(powderNode.isRawMaterial).toBe(true);
    }
  });

  test("liquid-mode gating: locking the planter liquid-mode tech removes its recipes", () => {
    // tech_jinlong_1_planter_mode_1 unlocks `liquid` mode on planter_1
    // (planter_plant_grass_*_1). Without it, those liquid recipes are gated.
    const researched = allButNotResearched("tech_jinlong_1_planter_mode_1");
    const activeDomains = allDomainsActive();
    const unlockedFacilities = computeUnlockedFacilities(
      researched,
      activeDomains,
    );
    const unlockedModes = computeUnlockedModes(researched, unlockedFacilities);
    const { availableRecipes } = computeRecipeAvailability(
      recipes,
      unlockedFacilities,
      unlockedModes,
    );

    // planter_1 stays unlocked (its facility-unlock tech, tech_tundra_2_plant_1, is still researched).
    expect(unlockedFacilities.has(FacilityId.PLANTER_1)).toBe(true);
    // Its liquid-mode recipes are gated.
    expect(
      availableRecipes.some((r) => r.id === "planter_plant_grass_1_1"),
    ).toBe(false);
    expect(
      availableRecipes.some((r) => r.id === "planter_plant_grass_2_1"),
    ).toBe(false);
    // Normal-mode planter recipes (e.g. planter_plant_moss_1_1) are still available.
    expect(
      availableRecipes.some((r) => r.id === "planter_plant_moss_1_1"),
    ).toBe(true);
  });

  test("targetable-items derivation matches the union of recipe outputs", () => {
    // The App-layer derivation: items reachable as targets are exactly
    // those produced by ANY available recipe (and `asTarget !== false`).
    // This test pins the contract: if a recipe is available, its
    // outputs are targetable; if a recipe is gated, its outputs are
    // only targetable if produced by ANOTHER available recipe.
    const researched = allResearched();
    const activeDomains = allDomainsActive();
    const unlockedFacilities = computeUnlockedFacilities(
      researched,
      activeDomains,
    );
    const unlockedModes = computeUnlockedModes(researched, unlockedFacilities);
    const { availableRecipes } = computeRecipeAvailability(
      recipes,
      unlockedFacilities,
      unlockedModes,
    );

    const reachableFromRecipes = new Set<ItemId>();
    for (const r of availableRecipes) {
      for (const o of r.outputs) reachableFromRecipes.add(o.itemId);
    }

    const targetableItems = items.filter(
      (item) =>
        reachableFromRecipes.has(item.id) && item.asTarget !== false,
    );

    // Sanity: with everything unlocked, the targetable set is non-trivial.
    expect(targetableItems.length).toBeGreaterThan(0);
    // Every targetable item is produced by at least one available recipe.
    for (const item of targetableItems) {
      const hasProducer = availableRecipes.some((r) =>
        r.outputs.some((o) => o.itemId === item.id),
      );
      expect(hasProducer).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// Chain-reachability composition: AIC filter → recipe-reachability →
// canonical `availableRecipes` (the App-layer pipeline)
// ════════════════════════════════════════════════════════════════════

describe("AIC integration: chain-reachability filter", () => {
  /**
   * Helper that composes the two filters exactly the way App.tsx does:
   * computeRecipeAvailability (AIC-only) → computeRecipeReachability
   * (chain from forced raws, with bootstrap exception for the Seed-
   * Picking Unit) → canonical availableRecipes set.
   */
  const composeAvailableRecipes = (
    researched: ReadonlySet<AicTechId>,
    activeDomains: ReadonlySet<DomainId>,
  ) => {
    const unlockedFacilities = computeUnlockedFacilities(
      researched,
      activeDomains,
    );
    const unlockedModes = computeUnlockedModes(
      researched,
      unlockedFacilities,
    );
    const aicFiltered = computeRecipeAvailability(
      recipes,
      unlockedFacilities,
      unlockedModes,
    ).availableRecipes;
    return computeRecipeReachability(
      aicFiltered,
      forcedRawMaterials,
      bootstrapFacilities,
    );
  };

  test("locking Furnace removes xiranite_oven_xiranite_powder_1 from availableRecipes (Carbon Enr unreachable)", () => {
    // Pins the user-reported scenario: Furnace locked → Carbon Enr
    // has no producer in the AIC-filtered set AND isn't a forced raw
    // → xiranite_oven_xiranite_powder_1 is chain-blocked. The chain
    // filter excludes it from `availableRecipes`, so the picker never
    // surfaces Xiranite Powder.
    const researched = allButNotResearched("tech_tundra_1_furnance_1");
    const activeDomains = allDomainsActive();
    const { runnableRecipes, reachableItems } = composeAvailableRecipes(
      researched,
      activeDomains,
    );

    // Xiranite Powder recipe is filtered out (input chain broken).
    expect(
      runnableRecipes.some((r) => r.id === "xiranite_oven_xiranite_powder_1"),
    ).toBe(false);
    // Xiranite Powder is NOT reachable.
    expect(reachableItems.has(ItemId.ITEM_XIRANITE_POWDER)).toBe(false);
    // Carbon Enr is also NOT reachable (its only producer is Furnace).
    expect(reachableItems.has(ItemId.ITEM_CARBON_ENR)).toBe(false);
  });

  test("cascade: locking grinder removes downstream chain (carbon_powder, iron_powder, etc.)", () => {
    // Grinder produces several powders. Locking it cascades into
    // recipes that need those powders. The transitive closure
    // correctly removes the entire downstream chain.
    const researched = allButNotResearched("tech_tundra_1_grinder_1");
    const activeDomains = allDomainsActive();
    const { runnableRecipes, reachableItems } = composeAvailableRecipes(
      researched,
      activeDomains,
    );

    // No grinder recipes remain (AIC filter caught these directly).
    expect(
      runnableRecipes.some((r) => r.facilityId === FacilityId.GRINDER_1),
    ).toBe(false);

    // Items only produced by grinder become unreachable.
    expect(reachableItems.has(ItemId.ITEM_IRON_POWDER)).toBe(false);
    expect(reachableItems.has(ItemId.ITEM_CARBON_POWDER)).toBe(false);

    // Downstream recipes that consume those powders are gone.
    // E.g., furnance_iron_nugget_2 consumes item_iron_powder → blocked.
    // (Sibling furnance_iron_nugget_1 consumes iron_ore directly, a
    // forced raw, so it survives — providing an alternative producer
    // for iron_nugget.)
    expect(
      runnableRecipes.some((r) => r.id === "furnance_iron_nugget_2"),
    ).toBe(false);
    // Iron Nugget itself stays reachable via the iron_ore path.
    expect(reachableItems.has(ItemId.ITEM_IRON_NUGGET)).toBe(true);
  });

  test("manual-raw rescue does NOT work at the App-layer filter: locking Furnace + 'pinning' Carbon Enr does NOT bring back xiranite_powder", () => {
    // Confirms the design decision: the App-layer filter uses ONLY
    // forced raws. Even if a user has manual raws set (or thinks
    // they should rescue chains), the App-layer `availableRecipes`
    // doesn't include manual raws in its closure. The recipe stays
    // filtered out.
    //
    // (This is the helper's contract — verified pure in
    // recipe-reachability.test.ts; here we pin the App-layer policy.)
    const researched = allButNotResearched("tech_tundra_1_furnance_1");
    const activeDomains = allDomainsActive();
    const { runnableRecipes } = composeAvailableRecipes(
      researched,
      activeDomains,
    );
    // Even if the user "intended" to rescue via manual raw, the
    // composed `availableRecipes` is closed over forced raws only.
    // Xiranite Powder recipe stays out.
    expect(
      runnableRecipes.some((r) => r.id === "xiranite_oven_xiranite_powder_1"),
    ).toBe(false);
  });

  test("default config: moss plants and seeds are reachable via seedcollector bootstrap", () => {
    // The planter↔seedcollector cycle has no forced-raw entry point.
    // Without the bootstrap exception for `seedcollector_1`, the
    // chain closure would mark both recipes as blocked and the
    // picker would hide moss plants entirely. With bootstrap, the
    // cycle seeds itself: seedcollector recipes are unconditionally
    // runnable, their seed outputs join reachableItems, planter
    // recipes become runnable (seeds now satisfied), and plant
    // outputs follow.
    const researched = allResearched();
    const activeDomains = allDomainsActive();
    const { runnableRecipes, reachableItems } = composeAvailableRecipes(
      researched,
      activeDomains,
    );

    // Both sides of the cycle are runnable.
    expect(
      runnableRecipes.some((r) => r.id === "seedcollector_plant_moss_1_1"),
    ).toBe(true);
    expect(
      runnableRecipes.some((r) => r.id === "planter_plant_moss_1_1"),
    ).toBe(true);

    // Both plant AND seed are reachable.
    expect(reachableItems.has(ItemId.ITEM_PLANT_MOSS_1)).toBe(true);
    expect(reachableItems.has(ItemId.ITEM_PLANT_MOSS_SEED_1)).toBe(true);
  });

  test("locking tech_tundra_2_plant_1 (both planter + seedcollector locked) → moss plants unreachable", () => {
    // tech_tundra_2_plant_1 unlocks BOTH planter_1 (primary) and
    // seedcollector_1 (via additionalFacilities). Locking it removes
    // the bootstrap entry point along with the planter recipes.
    // Result: plant/seed cycle is unreachable, picker hides them.
    const researched = allButNotResearched("tech_tundra_2_plant_1");
    const activeDomains = allDomainsActive();
    const { runnableRecipes, reachableItems } = composeAvailableRecipes(
      researched,
      activeDomains,
    );

    // Neither cycle recipe is runnable.
    expect(
      runnableRecipes.some((r) => r.id === "seedcollector_plant_moss_1_1"),
    ).toBe(false);
    expect(
      runnableRecipes.some((r) => r.id === "planter_plant_moss_1_1"),
    ).toBe(false);

    // Plants and seeds aren't reachable.
    expect(reachableItems.has(ItemId.ITEM_PLANT_MOSS_1)).toBe(false);
    expect(reachableItems.has(ItemId.ITEM_PLANT_MOSS_SEED_1)).toBe(false);
  });
});
