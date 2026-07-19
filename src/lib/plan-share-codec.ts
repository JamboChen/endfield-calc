/**
 * Shared-plan settings codec.
 *
 * # Why
 *
 * The URL hash already carries the *plan definition* (targets, recipe
 * pins, flags — see `useProductionPlan.ts`). It does NOT carry the
 * *domain/user settings* the plan was solved against (region, AIC
 * research, facility/raw caps, structures, metastorage routes), which
 * live in localStorage. Two users with different settings therefore
 * compute different plans from the same link.
 *
 * This module encodes the plan-relevant settings snapshot (a
 * `PersistedShape`) into a compact, URL-safe `s=` hash blob so a link is
 * self-contained, and decodes it back on the receiving side. The
 * provider then drives a read-only "viewing a shared plan" mode from the
 * decoded snapshot without touching the viewer's own localStorage.
 *
 * # Staying small
 *
 * The blob is a **per-top-level-field delta from the first-run default
 * shape** (`DEFAULT_PERSISTED_SHAPE`), then lz-string compressed. A
 * default user's delta is `{}` → a handful of characters; the blob only
 * grows for fields the sharer actually customized. Both sides compute
 * the same default baseline (same app/data version), so the delta
 * round-trips exactly.
 *
 * # URL transport
 *
 * `compressToEncodedURIComponent` output is URI-safe but can contain
 * `+`, which `URLSearchParams` would mangle (→ space). So the blob is
 * appended to / read from the hash manually (`withShareBlob` /
 * `readShareBlobFromHash`), NOT via `URLSearchParams`. `+` is a valid
 * unencoded fragment character (RFC 3986), so it survives copy-paste.
 *
 * # Robustness
 *
 * Decoding funnels through `sanitizePersistedShape` (the same defensive
 * id-filter + invariant enforcement localStorage uses), wrapped in
 * try/catch → `null` on corrupt input, so the receiver falls back to
 * their own settings rather than erroring.
 */

import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";

import {
  DEFAULT_PERSISTED_SHAPE,
  canonicalizeShape,
  sanitizePersistedShape,
  type PersistedShape,
} from "@/hooks/useDomainSettings";

/** The hash key under which the settings blob rides. */
const SHARE_HASH_KEY = "s";

/**
 * The five top-level `PersistedShape` fields the codec diffs
 * independently. Every one is present in `DEFAULT_PERSISTED_SHAPE`
 * (`stateToPersistedShape` always emits them), so per-key comparison is
 * total.
 */
const DELTA_KEYS = [
  "domains",
  "aic",
  "rawLimits",
  "structures",
  "metastorage",
] as const satisfies readonly (keyof PersistedShape)[];

/**
 * Encode a settings snapshot into the compact `s=` blob value. Input is
 * sanitized + canonicalized first, so any channel (live settings, a
 * hand-edited saved file) yields the same output for the same effective
 * settings. Fields equal to the first-run default are omitted.
 */
export function encodeSettingsSnapshot(shape: PersistedShape): string {
  try {
    const canonical = canonicalizeShape(
      sanitizePersistedShape(shape) ?? DEFAULT_PERSISTED_SHAPE,
    );
    const delta: Record<string, unknown> = {};
    for (const key of DELTA_KEYS) {
      if (
        JSON.stringify(canonical[key]) !==
        JSON.stringify(DEFAULT_PERSISTED_SHAPE[key])
      ) {
        delta[key] = canonical[key];
      }
    }
    return compressToEncodedURIComponent(JSON.stringify(delta));
  } catch {
    // Runs inside a render-time `useMemo` (the URL `s=` sync). Never
    // break the render over a settings-encode failure — degrade to a
    // settings-less hash; the decode side then falls back to the
    // viewer's own settings.
    return "";
  }
}

/**
 * Decode an `s=` blob back into a clean `PersistedShape`. Reconstructs
 * the full shape by overlaying the decoded delta on the default
 * baseline, then sanitizes. Returns `null` for empty / corrupt /
 * cross-version-incompatible input (caller falls back to own settings).
 */
export function decodeSettingsSnapshot(blob: string): PersistedShape | null {
  try {
    const json = decompressFromEncodedURIComponent(blob);
    // lz-string returns "" for empty input and null for malformed input
    // (its typings understate the null case).
    if (!json) return null;
    const delta = JSON.parse(json) as unknown;
    if (!delta || typeof delta !== "object") return null;
    return sanitizePersistedShape({
      ...DEFAULT_PERSISTED_SHAPE,
      ...(delta as Record<string, unknown>),
    });
  } catch {
    return null;
  }
}

/**
 * True iff two shapes describe the same effective settings (canonical
 * JSON equality). The provider uses this to decide shared-view vs normal
 * mode: identical snapshot and own settings → no shared-view.
 */
export function shapesEqual(a: PersistedShape, b: PersistedShape): boolean {
  return (
    JSON.stringify(canonicalizeShape(a)) === JSON.stringify(canonicalizeShape(b))
  );
}

/**
 * Extract the raw `s=` blob from a location hash (with or without the
 * leading `#`). Read manually rather than via `URLSearchParams` to
 * preserve any `+` characters in the lz-string output. Returns `null`
 * when absent or empty.
 */
export function readShareBlobFromHash(hash: string): string | null {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  const match = body.match(/(?:^|&)s=([^&]*)/);
  return match && match[1] ? match[1] : null;
}

/**
 * Append the settings blob to a plan-fields hash string (the value of
 * `URLSearchParams.toString()` for `t/r/m/...`). Centralizes the `s=`
 * format so the writer and reader can't drift.
 */
export function withShareBlob(baseHash: string, encoded: string): string {
  if (!encoded) return baseHash;
  return baseHash
    ? `${baseHash}&${SHARE_HASH_KEY}=${encoded}`
    : `${SHARE_HASH_KEY}=${encoded}`;
}
