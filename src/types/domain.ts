/**
 * Generic domain / region types.
 *
 * "Domain" is the in-game-data term (`domain_1`, `domain_2`, …); players
 * see localized region names like "Valley IV" and "Wuling". The settings
 * UI is organised by domain — each domain section may host several
 * setting categories (today: AIC Plan; later: region limits, power
 * budget, etc.). These types are intentionally **category-agnostic** so
 * future per-domain features can compose against the same primitives.
 *
 * Specific category types (AIC, etc.) live in their own type files and
 * import `DomainId` from here.
 */

/**
 * Brand intersection for in-game domain ids (`domain_1`, `domain_2`, …).
 * Currently only two exist but the schema permits more — kept as a brand.
 */
type DomainId = string & { readonly __brand: "DomainId" };

/**
 * A first-class domain entry, surfaced as a top-level section in the
 * settings UI. Sourced from the upstream game-data dump by `pnpm run
 * extract:aic` (today the script is named after AIC since that's the
 * only category; it will be renamed when a second category lands).
 *
 * - `isPinned` — when `true`, the activation toggle is hidden and the
 *   domain is always-active. Derived at extraction time from
 *   `sortId === 1` (the starting domain is pinned).
 * - `sortId` — display order in the sheet.
 * - `color` — hex string without `#`, sourced from upstream
 *   `domainColor`. Used as the section's left accent stripe.
 */
type Domain = {
  readonly id: DomainId;
  readonly isPinned: boolean;
  readonly sortId: number;
  readonly color: string;
};

export type { DomainId, Domain };
