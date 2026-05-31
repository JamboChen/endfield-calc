/**
 * Resolve the on-disk icon URL for a facility.
 *
 * Two render paths share this helper:
 *   1. Settings → Plan / Limits tabs, which have only a `FacilityId`
 *      and call `facilityIconUrl()` directly.
 *   2. The `<FacilityIcon>` component
 *      (`src/components/FacilityIcon.tsx`), which prefers
 *      `Facility.iconUrl` (set at module-load via this helper, so the
 *      two stay in sync) and falls back here when given just an id.
 *
 * **Single source of truth**: both the auto-generated `facilities.ts`
 * and the hand-curated `manual-facilities.ts` populate
 * `Facility.iconUrl` by calling `facilityIconUrl(f.id)` at load time,
 * so every consumer — whether it reads the data field or calls the
 * helper — resolves the same path.
 *
 * Facilities without a populated data-dump icon resolve to
 * `images/facilities/{id}.png` by default. Exceptions live in
 * `FACILITY_ICON_PATH` below.
 */

/**
 * Per-facility subpath under `public/images/` for the icon asset.
 * Values are `directory/basename` (no extension); the helper appends
 * `.png` and the Vite `BASE_URL` prefix.
 *
 * - **`facilities/...`** — colored building renders (the default
 *   shape for every auto-generated facility).
 * - **`structures/...`** — monochrome game port glyphs reused for
 *   synthetic manual facilities that have no canonical building icon.
 *   These need `invert dark:invert-0` styling to render correctly;
 *   `isMonochromeFacilityIcon()` detects them by path prefix.
 *
 * Adding a new entry:
 *   - Real asset under `public/images/facilities/{id}.png` → no entry
 *     needed (default path works).
 *   - Reuse of an existing asset (e.g. Depot Bus shares the unloader
 *     icon) → add `id: "facilities/{shared-id}"`.
 *   - Reuse of a monochrome structure glyph → add
 *     `id: "structures/{slug}"`.
 */
const FACILITY_ICON_PATH: Partial<Record<string, string>> = {
  // Depot Bus tech (loader_1) reuses the colored Depot Unloader icon —
  // both facilities unlock together and share the same visual cue.
  loader_1: "facilities/unloader_1",
  // Synthetic facility — collapses three Wuling Sewage Inlet gates
  // into one capped LP-side unit. The game ships only the port glyph
  // (under `structures/`), so we reuse it here; `iconIsMonochrome`
  // on the Facility record drives the required invert styling.
  liquid_clean_gate_1: "structures/icon_port_liquid_clean_gate_1",
};

export function facilityIconUrl(facilityId: string): string {
  const path = FACILITY_ICON_PATH[facilityId] ?? `facilities/${facilityId}`;
  return `${import.meta.env.BASE_URL}images/${path}.png`;
}

/**
 * True when this facility's icon is a monochrome game glyph that
 * requires `invert dark:invert-0` styling. Detected by the
 * `structures/` path prefix in `FACILITY_ICON_PATH`.
 *
 * Callers without a full `Facility` object (Settings Plan / Limits
 * tabs hold only the id) use this predicate; callers that have the
 * full object can read `Facility.iconIsMonochrome` directly (set at
 * data-load via this same predicate, so the two stay aligned).
 */
export function isMonochromeFacilityIcon(facilityId: string): boolean {
  return FACILITY_ICON_PATH[facilityId]?.startsWith("structures/") ?? false;
}

/**
 * Icon URL for a region structure (Purification Node parts). Assets live
 * under `public/images/structures/` keyed by `RegionStructure.iconSlug`
 * (the game's `iconOnPanel` basename, e.g. `icon_port_liquid_clean_gate_1`).
 */
export function structureIconUrl(iconSlug: string): string {
  return `${import.meta.env.BASE_URL}images/structures/${iconSlug}.png`;
}
