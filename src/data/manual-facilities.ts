import type { Facility } from "@/types";
import { FacilityId } from "@/types/constants";
import { facilityIconUrl, isMonochromeFacilityIcon } from "@/lib/facility-icons";

/**
 * Manually-curated facilities — synthetic entries that do NOT appear in
 * the upstream game-data dump and therefore can't be emitted by
 * `scripts/extract-facilities.ts`. Combined with the auto-generated
 * `facilities.ts` array in `data/index.ts` (manual wins over any
 * auto-generated id collision).
 *
 * **Naming convention** (mirrors `facilities.ts`): use the upstream game
 * building ID verbatim. When a single LP-side facility represents
 * multiple in-game buildings collapsed for solver compactness, name it
 * after the **canonical / tier-1** game building. Today's sole entry is
 * `liquid_clean_gate_1`, which represents the three Wuling sewage inlet
 * gates (`liquid_clean_gate_1/2/3`) collapsed into one capped facility —
 * they're functionally identical for LP purposes (same throughput, same
 * recipe semantics), and the cap = number of enabled inlets is set via
 * the structures bridge in `src/App.tsx`. Mirrors how `liquid_cleaner_1`
 * represents the Water Treatment Unit even when game tiers 2/3 exist.
 *
 * **DO NOT** add `liquid_clean_gate_1` to `GROUP_A_ALLOWLIST` in
 * `scripts/build-facilities.ts`. The auto-generated record would
 * conflict with the hand-tuned values here (power, buffers, domains).
 * The `@/data` barrel's dedup filter would let this entry win, but
 * carrying two entries is fragile — leave the script's allowlist alone.
 *
 * Field choices for `LIQUID_CLEAN_GATE_1`:
 *   - `powerConsumption: 0` — map structures don't draw player power.
 *   - `category: 28` (LiquidCleaner) — matches `liquid_cleaner_1`'s
 *     classification since the LP semantics are identical (liquid sink
 *     with optional secondary output).
 *   - One pipe in + one pipe out — the disposal variant only uses the
 *     input port, but the byproduct variant needs the output for
 *     xiranite_poly. Sized for the schema; the mapper still classifies
 *     zero-output bins as disposal sinks based on recipe shape.
 *   - `domains: ["domain_2"]` — Wuling-only, matches the in-game
 *     placement restriction.
 *
 * **Icon**: manual facilities have no canonical building icon in the
 * game data — they're collapsed representations of map structures, not
 * placeable buildings. The asset (a monochrome structure port glyph)
 * lives alongside every other facility icon under
 * `public/images/facilities/{id}.png`; `iconUrl` is set via
 * `facilityIconUrl()` at data-load so every consumer reading the data
 * field resolves the same path. `iconIsMonochrome` comes from
 * `MONOCHROME_FACILITY_ICONS` (`src/lib/facility-icons.ts`) and tells
 * `<FacilityIcon>` to apply `invert dark:invert-0` styling so the
 * monochrome glyph is visible on both light and dark backgrounds.
 */
export const manualFacilities: Facility[] = [
  {
    id: FacilityId.LIQUID_CLEAN_GATE_1,
    tier: 1,
    category: 28,
    powerConsumption: 0,
    buffersIn: { belt: [], pipe: [{ ports: 1 }] },
    buffersOut: { belt: [], pipe: [{ ports: 1 }] },
    domains: ["domain_2"],
  },
];

manualFacilities.forEach((f) => {
  f.iconUrl = facilityIconUrl(f.id);
  f.iconIsMonochrome = isMonochromeFacilityIcon(f.id);
});
