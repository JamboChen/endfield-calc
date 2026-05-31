/**
 * Resolve the on-disk icon URL for a facility (or a structure asset
 * referenced by a `RegionStructure.iconSlug`).
 *
 * **Single asset directory**: every facility / structure icon lives
 * under `public/images/facilities/{id}.png`. The helper is a one-line
 * path builder; consumers are:
 *
 *   1. **Settings → Plan / Limits tabs**, which hold only a
 *      `FacilityId` and call `facilityIconUrl()` directly via
 *      `<FacilityIcon facilityId={...} />`.
 *   2. **Settings → Structures tab**, which holds a free-form
 *      `iconSlug` (today equal to the structure id) and calls
 *      `facilityIconUrl(s.iconSlug)` — the slug is just an asset
 *      basename from the helper's POV. The helper's parameter is
 *      typed `string` rather than `FacilityId` so structure-only
 *      slugs (e.g. `liquid_recycle_gate_1`, which has no
 *      `FacilityId` counterpart) can flow through without an `as`
 *      cast.
 *   3. **`<FacilityIcon>` component** elsewhere, which prefers
 *      `Facility.iconUrl` (populated at module-load via this helper,
 *      so the two stay aligned) and falls back here when given just
 *      an id.
 *
 * **Visual-style distinction**: monochrome game glyphs (synthetic
 * manual facilities reusing structure-port assets) get
 * `invert dark:invert-0` styling. That signal is carried by
 * `isMonochromeFacilityIcon()` for helper-only callers and by
 * `Facility.iconIsMonochrome` for component callers — both seeded
 * from the same `MONOCHROME_FACILITY_ICONS` Set below.
 *
 * Adding a new icon:
 *   - Drop the asset at `public/images/facilities/{id}.png`.
 *   - Colored building render: nothing else to do.
 *   - Monochrome glyph: add the id to `MONOCHROME_FACILITY_ICONS`.
 */

/**
 * Facilities whose icon is a monochrome game glyph and needs
 * `invert dark:invert-0` styling to remain visible on both light and
 * dark backgrounds. Today: synthetic manual facilities that reuse a
 * structure port glyph because no canonical building render ships in
 * the game data dump.
 *
 * Values are `FacilityId` string literals; the runtime type is
 * `Set<string>` so the membership check (`isMonochromeFacilityIcon`)
 * accepts arbitrary strings (including structure-only slugs from
 * `StructuresContent`) without a brand cast. Strings that aren't a
 * valid `FacilityId` simply return `false`.
 *
 * Structure-only ids (e.g. `liquid_recycle_gate_1`, which has no
 * `FacilityId` counterpart) aren't in here — `StructuresContent`
 * applies invert inline since every structure-tab icon is monochrome
 * by convention.
 */
const MONOCHROME_FACILITY_ICONS: ReadonlySet<string> = new Set([
  "liquid_clean_gate_1",
]);

export function facilityIconUrl(facilityId: string): string {
  return `${import.meta.env.BASE_URL}images/facilities/${facilityId}.png`;
}

export function isMonochromeFacilityIcon(facilityId: string): boolean {
  return MONOCHROME_FACILITY_ICONS.has(facilityId);
}
