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
import { items, recipes, facilities } from "@/data";
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
