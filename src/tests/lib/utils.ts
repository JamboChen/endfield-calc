/**
 * Shared test fixtures.
 *
 * Keep this file deliberately minimal — anything that's only used by
 * one test should stay local to that test. Promote here only when 3+
 * tests duplicate the same constant / helper.
 */
import { rawMaterialSources } from "@/data";
import type { ItemId } from "@/types";

/**
 * All items the canonical source-facility map knows about. Equivalent
 * to the old global `forcedRawMaterials` constant (removed in the
 * region-picker workstream); used as a default `rawMaterials` argument
 * for tests that don't care about per-region availability.
 *
 * Tests that DO care about per-region availability should construct
 * their own `Set<ItemId>` matching the region they're modelling — see
 * `region-raw-availability.test.ts` for the canonical shape.
 */
export const ALL_RAWS: ReadonlySet<ItemId> = new Set(
  rawMaterialSources.keys(),
);
