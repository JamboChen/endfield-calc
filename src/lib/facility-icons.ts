/**
 * Resolve the on-disk icon URL for a facility.
 *
 * Facilities carry no populated `iconUrl` in the data dump, so the path
 * is derived from the facility id: `images/facilities/{id}.png`. Callers
 * should render with an `onError` handler that hides the `<img>` (a few
 * facilities have no asset). Shared by `AicNodeRow` (Plan tab) and
 * `FacilityLimitsContent` (Limits tab) so both render the same icon.
 */

const FACILITY_ICON_FALLBACK: Partial<Record<string, string>> = {
  // Depot Bus tech ships under `loader_1` but the asset on disk lives
  // under `unloader_1.png`. Both facilities are unlocked together, so
  // the unloader icon is the right visual cue.
  loader_1: "unloader_1",
  // Synthetic facility — no upstream asset. Reuse the Water Treatment
  // Unit icon (same disposal-of-sewage semantics) so the bin renders
  // with a meaningful visual rather than a broken-image placeholder.
  sewage_inlet: "liquid_cleaner_1",
};

export function facilityIconUrl(facilityId: string): string {
  const slug = FACILITY_ICON_FALLBACK[facilityId] ?? facilityId;
  return `${import.meta.env.BASE_URL}images/facilities/${slug}.png`;
}

/**
 * Icon URL for a region structure (Purification Node parts). Assets live
 * under `public/images/structures/` keyed by `RegionStructure.iconSlug`
 * (the game's `iconOnPanel` basename, e.g. `icon_port_liquid_clean_gate_1`).
 */
export function structureIconUrl(iconSlug: string): string {
  return `${import.meta.env.BASE_URL}images/structures/${iconSlug}.png`;
}
