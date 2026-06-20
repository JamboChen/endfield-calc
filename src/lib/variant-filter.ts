import { facilityRecipeVariants } from "@/data";
import type { FacilityId, RecipeId } from "@/types";

/**
 * Returns the set of `facilityRecipeVariants` recipe ids that must be
 * excluded from the LP given the caller's view of the configuration.
 *
 * Single source of truth for the variant-exclusion rule. Both the
 * calculator (`src/lib/calculator.ts`) and the App layer
 * (`src/App.tsx`) delegate here.
 *
 * Two modes, distinguished by `mode`:
 *
 * **`cap-zero-only`** — calculator-side defensive gate.
 *   - `facilityCaps.get(F) === 0` (or missing) → exclude both variants.
 *   - `facilityCaps.get(F) > 0` → exclude nothing; the LP's lex
 *     objective (rawCost → buildingCount → power) naturally selects
 *     the cheaper variant.
 *
 *   Used by direct callers (tests, future programmatic entry points)
 *   that haven't resolved which variant the user wants. The App layer
 *   already applies the full rule before the calculator runs; this
 *   mode preserves today's defensive backstop without making
 *   assumptions about toggle state.
 *
 * **`structure-aware`** — App-side full rule with resolved Settings.
 *   - F not in `availableInstances` → exclude both
 *     (no physical buildings — neither variant should appear in the LP).
 *   - F in `availableInstances` + not in `toggledFacilities` →
 *     exclude `toggled` (toggle OFF — only the default/pure-sink variant).
 *   - F in `availableInstances` + in `toggledFacilities` →
 *     exclude NOTHING. The toggle is **additive** (issue #90): both
 *     variants stay in the LP, sharing the facility cap, and the LP
 *     routes the `toggled` recipe up to real downstream demand and falls
 *     back to `default` for the rest. This mirrors the `cap-zero-only`
 *     "cap > 0 → exclude nothing" branch. Concretely: the Byproduct
 *     Outlet lets a Sewage Inlet ALSO tap xiranite_poly from sewage it is
 *     already disposing — it does NOT force every unit through the
 *     byproduct path (which would mandate a Water Treatment Unit to
 *     destroy the unwanted effluent).
 *
 *   `availableInstances` is intentionally **not** derived from
 *   `facilityCaps` — a future variant facility with AIC cap-raise nodes
 *   could carry `cap > 0` purely from AIC even when no structure
 *   instances are enabled. The App layer's intent in that case is "no
 *   physical buildings → both variants unavailable", which requires
 *   a signal that reflects only structure-derived instance count.
 *   Today they coincide (LIQUID_CLEAN_GATE_1 has no AIC cap-raise
 *   nodes); the separation defends against future drift.
 *
 *   **Cross-layer invariant (toggle ON)**: keeping both variants here is
 *   only consistent with the calculator's `cap-zero-only` backstop
 *   because the App threads `facilityCaps[F] > 0` for every `F` in
 *   `availableInstances` (both signals derive from the same
 *   enabled-`instance` structure set — see `App.tsx`'s `facilityCaps` and
 *   `structureVariantExcluded` memos). If a future change ever let
 *   `availableInstances` hold a facility whose cap stayed `0`, the
 *   `cap-zero-only` gate would re-drop BOTH variants and silently undo the
 *   additive (issue #90) routing. Keep the two App memos in lockstep.
 */
export type VariantExclusionOpts =
  | {
      readonly mode: "cap-zero-only";
      readonly facilityCaps?: ReadonlyMap<FacilityId, number>;
    }
  | {
      readonly mode: "structure-aware";
      readonly availableInstances: ReadonlySet<FacilityId>;
      readonly toggledFacilities: ReadonlySet<FacilityId>;
    };

export function computeVariantExclusions(
  opts: VariantExclusionOpts,
): Set<RecipeId> {
  const excluded = new Set<RecipeId>();
  for (const [facilityId, variants] of facilityRecipeVariants) {
    if (opts.mode === "cap-zero-only") {
      const cap = opts.facilityCaps?.get(facilityId) ?? 0;
      if (cap <= 0) {
        excluded.add(variants.default);
        excluded.add(variants.toggled);
      }
      continue;
    }
    // structure-aware
    if (!opts.availableInstances.has(facilityId)) {
      // No physical buildings — neither variant should reach the LP.
      excluded.add(variants.default);
      excluded.add(variants.toggled);
    } else if (!opts.toggledFacilities.has(facilityId)) {
      // Toggle OFF — only the default (pure-sink) variant is active.
      excluded.add(variants.toggled);
    }
    // else: toggle ON — exclude nothing. The toggle is ADDITIVE (issue
    // #90); both variants share the facility cap and the LP picks between
    // them (toggled up to real downstream demand, default for the rest).
  }
  return excluded;
}
