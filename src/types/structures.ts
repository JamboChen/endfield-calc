import type { FacilityId, RegionStructureId } from "./constants";
import type { DomainId } from "./domain";

/**
 * Region-exclusive special structures (map buildings wired into a
 * factory; not roster/AIC buildings). Hand-curated in
 * `src/data/region-structures.ts` from the game's
 * `FactorySewageTreat{Import,Export}Table` +
 * `FactorySewageTreatPlantStoreTable`.
 *
 * Structures in a region form a linear opt-in chain via `requires`
 * (Wuling: Sewage Inlet 1 -> 2 -> 3 -> Byproduct Outlet). The Settings
 * "Structures" tab enforces the chain with a cascade.
 *
 * Each structure carries a `solver` discriminator that data-drives the
 * App-layer bridge in `src/App.tsx`:
 *   - `role: "instance"` — each enabled structure adds +1 to the
 *     calc-side cap of `facilityId` (e.g. each Sewage Inlet 1/2/3 is
 *     one physical building of `FacilityId.SEWAGE_INLET`).
 *   - `role: "recipeToggle"` — enabling switches the facility's active
 *     recipe to the toggled variant declared in
 *     `facilityRecipeVariants` (`src/data/index.ts`). The outlet itself
 *     is NOT a separate building — its effect is folded into the inlet
 *     recipe's stoichiometry. Display annotations still treat it as a
 *     distinct row in the Settings UI.
 *
 * The recipe numbers (sewage throughput, byproduct ratio) live on the
 * real `Recipe` entries pointed to by `facilityRecipeVariants` — not
 * here — so they can't drift from what the solver actually uses.
 */

type RegionStructureSolverRole =
  | { readonly role: "instance"; readonly facilityId: FacilityId }
  | { readonly role: "recipeToggle"; readonly facilityId: FacilityId };

type RegionStructure = {
  readonly id: RegionStructureId;
  readonly domainId: DomainId;
  /** Prereq structure in the chain; omitted for the chain head. */
  readonly requires?: RegionStructureId;
  /** i18n key under the `settings` namespace: `structures.<nameKey>`. */
  readonly nameKey: string;
  /** Display index for repeated structures (Sewage Inlet 1/2/3). */
  readonly index?: number;
  /** Backing game building id (documentation / future provenance). */
  readonly gameBuildingId: string;
  /** Icon basename under `public/images/structures/` (no extension). */
  readonly iconSlug: string;
  /** Solver-side effect of enabling this structure. */
  readonly solver: RegionStructureSolverRole;
};

export type { RegionStructure, RegionStructureSolverRole };
