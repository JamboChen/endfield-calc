import type { ItemId } from "@/types";
import type { DomainId } from "@/types/domain";

/**
 * Stable key for `(itemId, domainId)` entries in the raw-limit
 * override map. Uses a NUL delimiter no real id can contain — same
 * pattern as `capKey` in `aic-research-helpers.ts`.
 *
 * Used by `useDomainSettings.rawLimits.overrides` and by the
 * `RawLimitsCard` UI when reading / writing per-(item, domain)
 * limit values.
 */
export function rawLimitKey(itemId: ItemId, domainId: DomainId): string {
  return `${itemId}\u0000${domainId}`;
}

/**
 * Parse a `rawLimitKey` back into its parts. Returns `null` on
 * malformed input (missing NUL delimiter). Callers should treat the
 * return as a tuple of opaque branded ids; no further validation
 * happens here.
 */
export function parseRawLimitKey(
  key: string,
): { itemId: ItemId; domainId: DomainId } | null {
  const sep = key.indexOf("\u0000");
  if (sep === -1) return null;
  return {
    itemId: key.slice(0, sep) as ItemId,
    domainId: key.slice(sep + 1) as DomainId,
  };
}

/**
 * Aggregate the per-(raw item) caps for one region, in items/min.
 *
 * Seeds from `defaults` (the generated `defaultRawCapsByDomain` entry
 * for the region — its max mining output at max Regional Development
 * Level), then applies the user's `overrides` on top: a valid override
 * for `currentDomain` always wins over the default for the same item.
 *
 * **Defense-in-depth sanity filter**: override entries with non-finite
 * or negative values are skipped (the default, if any, survives). The
 * hook setter + loader already reject these, but a hand-edited
 * localStorage entry could sneak past — this final gate keeps invalid
 * values out of the LP / warning surface entirely.
 *
 * **No default + no override = no limit**: such items don't appear in
 * the result; the calc treats them as unconstrained (LP infinite-supply,
 * no over-cap warning possible). Today that's Burdo-Muck and the
 * liquids — see `src/data/raw-caps.ts`.
 *
 * Pure + deterministic so cap precedence is unit-testable without
 * rendering (`raw-limits-helpers.test.ts`).
 */
export function buildRawMaterialCaps(
  defaults: ReadonlyMap<ItemId, number> | undefined,
  overrides: ReadonlyMap<string, number>,
  currentDomain: DomainId,
): Map<ItemId, number> {
  const out = new Map<ItemId, number>(defaults ?? []);
  for (const [key, value] of overrides) {
    if (!Number.isFinite(value) || value < 0) continue;
    const parsed = parseRawLimitKey(key);
    if (!parsed) continue;
    if (parsed.domainId !== currentDomain) continue;
    out.set(parsed.itemId, value);
  }
  return out;
}
