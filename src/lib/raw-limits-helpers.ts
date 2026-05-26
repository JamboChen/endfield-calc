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
