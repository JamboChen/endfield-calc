import { items } from "./items";
import { facilities } from "./facilities";
import { recipes } from "./recipes";
import { FacilityId } from "@/types/constants";
import type { ItemId } from "@/types";
import type { DomainId } from "@/types/domain";

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
 * Back-compat alias for the legacy `Set<ItemId>` API. Derived from
 * `rawMaterialSources` keys. Solver layer (`flow-solver.ts`,
 * `graph-builder.ts`) and the AddTargetDialog use `.has()` / `for...of`
 * which both work on `ReadonlySet`.
 *
 * IMPORTANT: do not iterate this set to compute source-facility info
 * — use `rawMaterialSources` directly. The set carries no source data.
 */
const forcedRawMaterials: ReadonlySet<ItemId> = new Set(
  rawMaterialSources.keys(),
);

/**
 * Per-region raw-material availability. A raw appears in a region's set
 * only when the player can physically source it there.
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
 * The calc layer (`App.tsx` `availableRecipes` memo) threads
 * `rawAvailabilityByDomain.get(currentDomain)` into
 * `computeRecipeReachability` in place of the global `forcedRawMaterials`,
 * so recipes whose chain traces back to an unavailable raw fall out of
 * `availableRecipes` for the current region. Downstream, the existing
 * auto-prune in `useProductionPlan` removes targets that become
 * unreachable.
 *
 * `forcedRawMaterials` stays the global "items with no producer" set
 * used by `flow-solver.ts` / `graph-builder.ts`. The per-region set is
 * a narrower availability layer applied only at the reachability stage.
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
 * objective. Derived as `items.filter(isLiquid) ∩ forcedRawMaterials` —
 * currently `{item_liquid_water, item_liquid_acid}`. Both are pumped via
 * dedicated source facilities with effectively unbounded throughput and
 * trivial power.
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
 * lives next to `forcedRawMaterials` and uses the same source of truth.
 */
const costlessRaws: ReadonlySet<ItemId> = new Set(
  items
    .filter((item) => item.isLiquid === true && forcedRawMaterials.has(item.id))
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

export {
  items,
  facilities,
  recipes,
  rawMaterialSources,
  forcedRawMaterials,
  rawAvailabilityByDomain,
  costlessRaws,
  forcedDisposalItems,
  bootstrapFacilities,
  MAX_TARGETS,
};
export type { RawSourceConfig };
