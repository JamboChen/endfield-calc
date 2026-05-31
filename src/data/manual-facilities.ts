import type { Facility } from "@/types";
import { FacilityId } from "@/types/constants";

/**
 * Manually-curated facilities — synthetic entries that do NOT appear in
 * the upstream `FactoryBuildingTable.json` dump and therefore can't be
 * emitted by `scripts/build-facilities.ts`. Combined with the
 * auto-generated `facilities.ts` array in `data/index.ts`.
 *
 * Today: the `SEWAGE_INLET` map structure. In-game it's the Wuling
 * Purification Node's three sewage-treatment levels (`liquid_clean_gate_1
 * /_2/_3`); the calc collapses them into one capped facility because the
 * three game buildings are functionally identical and the user-facing
 * concern is "how many do I have unlocked". Number of instances is
 * threaded in as a `facilityCaps` entry from the Settings "Structures"
 * tab — see `App.tsx`'s `facilityCaps` memo for the aggregation and
 * `src/data/region-structures.ts` for the structure → facility bridge.
 *
 * `powerConsumption: 0` because map structures are environmental and
 * don't draw from the player's power budget. `domains: ["domain_2"]`
 * matches the in-game placement restriction (Wuling-only).
 *
 * Both `buffersIn` and `buffersOut` carry a single pipe port: the
 * disposal variant only uses the input port, but the byproduct variant
 * needs the output port to emit xiranite_poly. Sized for the schema; the
 * mapper still renders zero-output bins as disposal sinks based on
 * recipe shape, not facility shape.
 *
 * Icon falls back to `liquid_cleaner_1` via `facility-icons.ts`'s
 * `FACILITY_ICON_FALLBACK` — visually similar (Water Treatment Unit
 * iconography) and avoids shipping a duplicate asset.
 */
export const manualFacilities: Facility[] = [
  {
    id: FacilityId.SEWAGE_INLET,
    tier: 1,
    // GEnums.FacBuildingType: 28 = LiquidCleaner (matches LIQUID_CLEANER_1).
    category: 28,
    powerConsumption: 0,
    buffersIn: { belt: [], pipe: [{ ports: 1 }] },
    buffersOut: { belt: [], pipe: [{ ports: 1 }] },
    domains: ["domain_2"],
  },
];

manualFacilities.forEach((f) => {
  f.iconUrl = `${import.meta.env.BASE_URL}images/facilities/${f.id}.png`;
});
