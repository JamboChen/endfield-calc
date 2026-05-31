import { items } from "./items";
import { facilities as generatedFacilities } from "./facilities";
import { manualFacilities } from "./manual-facilities";
import { recipes } from "./recipes";
import { FacilityId, RecipeId } from "@/types/constants";
import type { Facility, ItemId, Recipe, RecipeId as RecipeIdType } from "@/types";
import type { DomainId } from "@/types/domain";

/**
 * Combined facility roster: the auto-generated set from upstream game
 * data plus the hand-curated synthetic entries (today:
 * `LIQUID_CLEAN_GATE_1`). Order is `generated, ...manual` so iteration
 * order in tests / mappers sees the well-known facilities first and the
 * synthetic tail last — keeps snapshot-style tests stable when a new
 * manual entry is added.
 *
 * **Dedup**: a manual entry with the same id as an auto-generated entry
 * wins. This is defensive against a future maintainer adding the
 * canonical game id (e.g. `liquid_clean_gate_1`) to the
 * `build-facilities.ts` allowlist — the manual record keeps its
 * hand-tuned values (power=0, domain-restricted) regardless. The
 * convention in `manual-facilities.ts` is "don't enable the script
 * allowlist for these ids", but this filter is the structural backstop.
 */
const manualFacilityIds = new Set(manualFacilities.map((f) => f.id));
const facilities: Facility[] = [
  ...generatedFacilities.filter((f) => !manualFacilityIds.has(f.id)),
  ...manualFacilities,
];

/**
 * Per-raw-material configuration assigning a source facility. The
 * source facility's power consumption × pickup-point count contributes
 * to the plan's total power via `aggregateBinTotals`.
 *
 * `ratePerMinute` overrides the default throughput inferred from
 * transport capacity (30/min belt, 120/min pipe). It's required for
 * liquid raws because pumps cap at 60/min (one cycle per second per
 * `msPerRound: 1000`), which is half the pipe capacity. Solid raws
 * via `unloader_1` default to belt capacity (30/min).
 */
type RawSourceConfig = {
  sourceFacility: FacilityId;
  ratePerMinute?: number;
};

/**
 * Source-facility map for raw materials. Adding a new raw requires
 * picking the in-game building that supplies it:
 *   - Solid ore/sand → unloader_1 (Depot Unloader, 0 W, 30/min)
 *   - Most liquids → pump_1 (Fluid Pump, 10 W, 60/min)
 *   - Acid → pump_2 (Acid Resistant Pump Mk II, 20 W, 60/min)
 *
 * `miner_4`'s in-game water consumption for `item_copper_ore` is
 * intentionally NOT modeled — `unloader_1` is the canonical solid
 * pickup point. The player handles ore extraction separately and feeds
 * pre-mined ore into the factory via belt.
 *
 * Phase 1 of the source-facility refactor. Phase 2+ will revisit
 * disposal (excess byproduct routing) once raws have visible costs.
 */
const rawMaterialSources = new Map<ItemId, RawSourceConfig>([
  ["item_originium_ore", { sourceFacility: FacilityId.UNLOADER_1 }],
  ["item_quartz_sand", { sourceFacility: FacilityId.UNLOADER_1 }],
  ["item_iron_ore", { sourceFacility: FacilityId.UNLOADER_1 }],
  ["item_copper_ore", { sourceFacility: FacilityId.UNLOADER_1 }],
  ["item_liquid_water", { sourceFacility: FacilityId.PUMP_1, ratePerMinute: 60 }],
  ["item_liquid_acid", { sourceFacility: FacilityId.PUMP_2, ratePerMinute: 60 }],
]);

/**
 * Per-region raw-material availability. A raw appears in a region's set
 * only when the player can physically source it there. **This map is
 * the sole source of truth for "what counts as a raw"** — the calc
 * layer receives the per-`currentDomain` set explicitly, and tests
 * construct their own raw sets when they need different semantics.
 *
 * Two distinct sourcing models, each with a different rule:
 *
 *   - **Solid raws** are tied to discrete in-world POIs (the
 *     `int_minerbase_*` interactive types — confirmed in
 *     `InteractiveMarkDataTable.json` from the upstream data dump).
 *     POI placements are scene-data, NOT in `TableCfg`, so no auto-
 *     extraction is possible. Hand-curated per region from observed
 *     in-game inventory:
 *       Valley IV (domain_1): originium, ferrium (iron), amethyst (quartz)
 *       Wuling    (domain_2): originium, ferrium (iron), cuprium (copper)
 *
 *   - **Liquid raws** are tied to pump deployability. Both `pump_1`
 *     and `pump_2` carry `Facility.domains: ["domain_2"]` (set in the
 *     facility schema refactor), so liquids appear in Wuling's set
 *     only. The drift-detection test in
 *     `region-raw-availability.test.ts` enforces this invariant — if a
 *     pump's `Facility.domains` ever changes, that test fails until
 *     this map is updated.
 *
 * Invariants asserted by `region-raw-availability.test.ts`:
 *   1. Soundness — every per-region raw has a `rawMaterialSources` entry.
 *   2. Completeness — every `rawMaterialSources` key appears in at least
 *      one region's set (a new raw added without region mapping would
 *      be unreachable everywhere; the test catches this drift).
 *   3. Coverage — every domain in the registry has an entry here, so
 *      `App.tsx`'s `regionRawMaterials.get(currentDomain)!` is safe.
 *
 * The calc layer (`App.tsx` → `useProductionPlan` →
 * `calculateProductionPlan`) receives the per-`currentDomain` set as
 * an explicit `rawMaterials` parameter. No code path imports this
 * constant directly except `App.tsx`, the picker, and the persistence
 * defensive filter in `useDomainSettings`.
 */
const rawAvailabilityByDomain: ReadonlyMap<DomainId, ReadonlySet<ItemId>> =
  new Map<DomainId, ReadonlySet<ItemId>>([
    [
      "domain_1" as DomainId,
      new Set<ItemId>([
        "item_originium_ore",
        "item_iron_ore",
        "item_quartz_sand",
      ]),
    ],
    [
      "domain_2" as DomainId,
      new Set<ItemId>([
        "item_originium_ore",
        "item_iron_ore",
        "item_copper_ore",
        "item_liquid_water",
        "item_liquid_acid",
      ]),
    ],
  ]);

/**
 * Raw materials whose consumption is treated as **zero-cost** in the LP
 * objective. Derived as `items.filter(isLiquid) ∩ rawMaterialSources.keys()`
 * — currently `{item_liquid_water, item_liquid_acid}`. Both are pumped via
 * dedicated source facilities with effectively unbounded throughput and
 * trivial power.
 *
 * This is a TYPE classification (region-independent): the LP-side
 * zero-cost bias applies wherever the recipe runs. A water-consuming
 * recipe in Wuling pays zero raw-cost regardless of how many pumps
 * actually deliver the water. Per-region availability (whether water
 * is reachable here at all) is the orthogonal concern owned by
 * `rawAvailabilityByDomain`.
 *
 * Rationale: prior to this set, the LP's raw-cost objective biased
 * selection against recipes that happened to consume water/acid (e.g.
 * Yazhen planter requires water; Buckflower planter does not). Because
 * raws are excluded from balance constraints, this bias was the LP's
 * only way to "see" liquid consumption — making it falsely treat liquid
 * raws as scarce. Zeroing their objective coefficient lets the LP pick
 * recipes on building/power grounds instead.
 *
 * The set is symmetric on the output side: liquid raws produced as
 * byproducts (e.g. acid from `liquid_purifier_copper_enr_1`) were never
 * credited to the LP (raws have no balance constraint), so making
 * their input cost zero introduces no new asymmetry.
 *
 * Auto-extends if game data adds a new liquid raw — the derivation
 * uses `rawMaterialSources` as the anchor.
 */
const costlessRaws: ReadonlySet<ItemId> = new Set(
  items
    .filter(
      (item) => item.isLiquid === true && rawMaterialSources.has(item.id),
    )
    .map((item) => item.id),
);

const MAX_TARGETS = 12;

// Items that are mandatory byproducts and must be disposed of (consumed by a disposal recipe).
// When a production recipe generates these as a byproduct, the disposal recipe is automatically included.
const forcedDisposalItems = new Set<ItemId>([
  "item_liquid_sewage",
  "item_liquid_xiranite_lowpoly",
  "item_liquid_xiranite_poly",
]);

/**
 * Facilities whose recipes bypass the recipe-reachability chain check.
 * When a bootstrap facility is unlocked (present in `availableRecipes`
 * after the AIC filter), all of its recipes are unconditionally marked
 * `runnable` and their outputs join `reachableItems` before the normal
 * fixpoint runs in `computeRecipeReachability`.
 *
 * Use case: the Seed-Picking Unit (`seedcollector_1`) produces seeds
 * from plants and consumes plants made by the planter. The planter ↔
 * seedcollector cycle has no entry from forced raws, so the chain
 * closure would mark both as blocked. The game mechanics allow the
 * player to externally seed the cycle (wild plant collection, market
 * purchases, starting inventory). Modeling seedcollector as bootstrap-
 * capable mirrors this.
 *
 * The prefill-detection layer (`computeBootableItems` in
 * `calculator.ts`) intentionally does NOT use bootstrap. Its
 * "Planter ↔ Seedcollector" cycle warning still fires correctly —
 * bootstrap is a *planning-layer* concept ("can the user configure
 * this plan?"), prefill is a *runtime-execution* concept ("does the
 * cycle need a kickstart at startup?"). Both are simultaneously true.
 *
 * Adding to this set: any facility whose recipes the game considers
 * "always usable when the building exists, regardless of where the
 * inputs come from". Source facilities (`pump_*`, `unloader_*`)
 * don't belong here — they're modeled as raw sources via
 * `rawMaterialSources`, not recipe-running facilities.
 */
const bootstrapFacilities: ReadonlySet<FacilityId> = new Set([
  FacilityId.SEEDCOLLECTOR_1,
]);

/**
 * Per-facility recipe-variant pairs gated by a structure toggle.
 *
 * Each entry says: "facility F has two interchangeable recipes — the
 * `default` runs when no enabled structure toggles F, the `toggled`
 * runs when at least one enabled structure has `solver = { role:
 * "recipeToggle", facilityId: F }`". The App-layer bridge in
 * `src/App.tsx` walks this map together with `regionStructures` +
 * `structures.enabled` to build the `recipeConstraints` exclusion set.
 *
 * Today's sole entry is `LIQUID_CLEAN_GATE_1`:
 *   - `default` = `LIQUID_CLEAN_GATE_1_DISPOSAL` (pure sink; Byproduct Outlet OFF)
 *   - `toggled` = `LIQUID_CLEAN_GATE_1_BYPRODUCT` (emits xiranite_poly; ON)
 *
 * The two recipes share the same facility AND the same per-building
 * sewage throughput (120/min) by construction, so the LP's facility-cap
 * constraint on `LIQUID_CLEAN_GATE_1` correctly bounds the number of
 * physical inlets regardless of which variant is active.
 *
 * Invariant (verified at module load by the DEV/test self-check
 * immediately below): every entry's `default` and `toggled` recipes
 * must exist in `recipes` AND share their `facilityId` with the map
 * key. Violating this would make the facility-cap constraint
 * inconsistent with the recipe filter, causing the LP to silently
 * misbalance.
 */
const facilityRecipeVariants: ReadonlyMap<
  FacilityId,
  { readonly default: RecipeIdType; readonly toggled: RecipeIdType }
> = new Map([
  [
    FacilityId.LIQUID_CLEAN_GATE_1,
    {
      default: RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL,
      toggled: RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT,
    },
  ],
]);

// Module-load self-check for `facilityRecipeVariants`. Verifies three
// invariants for every entry — caught at boot so the LP can't silently
// misbalance:
//
//   1. Both `default` and `toggled` recipe ids exist in `recipes`.
//   2. Each recipe's `facilityId` matches the map key.
//   3. Both variants consume the same items at the same per-minute
//      rate (output shapes intentionally NOT checked — BYPRODUCT
//      producing xiranite_poly while DISPOSAL produces nothing IS the
//      point of a variant pair).
//
// **Why input-rate parity matters**: variants share a facility and a
// building-count budget (the LP allocates one `x_r` per variant from
// the same `facilityCaps[F]` ceiling). If their consumption rates
// diverged, toggling the recipeToggle would silently shift the LP's
// input-balance side and distort upstream production. Today
// LIQUID_CLEAN_GATE_1 variants both consume 120 sewage/min via
// (amount=1, time=0.5s) and (amount=30, time=15s); this check pins
// the equality so future tunings can't drift apart unnoticed.
//
// Gated on DEV mode OR test mode so production users never see a
// crash from a developer error that wasn't caught in CI. Cost is
// O(V × I) where V = variant pairs and I = avg inputs/recipe
// (≈ O(2) today); negligible.
if (
  import.meta.env?.DEV ||
  import.meta.env?.MODE === "test"
) {
  // Rate calc inlined — importing `calcRate` from `@/lib/utils` would
  // create a `@/data` → `@/lib/utils` → `@/data` cycle.
  const inputRateMap = (recipe: Recipe): Map<ItemId, number> => {
    const m = new Map<ItemId, number>();
    for (const inp of recipe.inputs) {
      m.set(
        inp.itemId,
        (m.get(inp.itemId) ?? 0) + (inp.amount * 60) / recipe.craftingTime,
      );
    }
    return m;
  };

  const resolveVariant = (
    facilityId: FacilityId,
    variantId: RecipeIdType,
  ): Recipe => {
    const recipe = recipes.find((r) => r.id === variantId);
    if (!recipe) {
      throw new Error(
        `facilityRecipeVariants: recipe ${variantId} (mapped under ${facilityId}) is not in \`recipes\``,
      );
    }
    if (recipe.facilityId !== facilityId) {
      throw new Error(
        `facilityRecipeVariants: recipe ${variantId} has facilityId ${recipe.facilityId} but the map key is ${facilityId}`,
      );
    }
    return recipe;
  };

  for (const [facilityId, variants] of facilityRecipeVariants) {
    const defRecipe = resolveVariant(facilityId, variants.default);
    const togRecipe = resolveVariant(facilityId, variants.toggled);

    const defRates = inputRateMap(defRecipe);
    const togRates = inputRateMap(togRecipe);
    if (defRates.size !== togRates.size) {
      throw new Error(
        `facilityRecipeVariants: ${facilityId} variants consume different item sets ` +
          `(${variants.default}: {${[...defRates.keys()].join(",")}}; ` +
          `${variants.toggled}: {${[...togRates.keys()].join(",")}})`,
      );
    }
    for (const [itemId, defRate] of defRates) {
      const togRate = togRates.get(itemId);
      if (togRate === undefined) {
        throw new Error(
          `facilityRecipeVariants: ${facilityId} variants disagree on ${itemId} ` +
            `(${variants.default} consumes it; ${variants.toggled} does not)`,
        );
      }
      if (Math.abs(defRate - togRate) > 1e-9) {
        throw new Error(
          `facilityRecipeVariants: ${facilityId} variants consume ${itemId} at ` +
            `different rates (${variants.default}: ${defRate}/min; ` +
            `${variants.toggled}: ${togRate}/min)`,
        );
      }
    }
  }
}

export {
  items,
  facilities,
  recipes,
  rawMaterialSources,
  rawAvailabilityByDomain,
  costlessRaws,
  forcedDisposalItems,
  bootstrapFacilities,
  facilityRecipeVariants,
  MAX_TARGETS,
};
export type { RawSourceConfig };
export { regionStructures } from "./region-structures";
