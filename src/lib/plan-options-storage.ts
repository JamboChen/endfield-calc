/**
 * Plan-option preferences — single source for the
 * `endfield-calc:plan-options-v1` localStorage key.
 *
 * The four plan options (display rounding, bin fusion, self-sustaining
 * power, the gas coverage ratio) used to live only in the URL, so they
 * reset to defaults on every fresh visit and were lost whenever the hash
 * was dropped. They persist here instead, as *preferences*.
 *
 * # Precedence: the URL wins wholly, or not at all
 *
 * `serializeHash` OMITS options that equal their default (`c` only when
 * on, `bf` only when off, …), so inside a link an absent param means
 * "the sharer had the default" — NOT "unspecified". Filling absent
 * params from these preferences would therefore reproduce a shared plan
 * with the *viewer's* options and silently compute something the sharer
 * never saw.
 *
 * So the read side is all-or-nothing, and lives in `useProductionPlan`:
 * a hash means "render exactly this plan state" (URL only), no hash
 * means "this is my app" (these preferences, else defaults).
 *
 * # Writing: per key, on explicit action only
 *
 * Never written on mount — only when a setter runs. Combined with
 * per-key writes, a viewer who opens a shared link and toggles one
 * option persists just that key; the sharer's other options never leak
 * into their preferences. Same anti-clobber rule the settings snapshot
 * follows, without needing read-only mode for four toggles.
 */

import { namespaceStorageKey } from "@/lib/storage-namespace";
import { sanitizeMachinesPerVaporizer } from "@/lib/sustain-constants";

const PLAN_OPTIONS_STORAGE_KEY = namespaceStorageKey(
  "endfield-calc:plan-options-v1",
);

/**
 * Persisted plan options. Every field is optional: a key is present only
 * once the user has actually set it, so an untouched option keeps
 * following the in-app default if that default ever changes.
 */
export interface StoredPlanOptions {
  ceilMode?: boolean;
  binFusion?: boolean;
  powerSustain?: boolean;
  machinesPerVaporizer?: number;
}

/** Coerce one parsed field, dropping anything of the wrong shape. */
function sanitize(parsed: Record<string, unknown>): StoredPlanOptions {
  const out: StoredPlanOptions = {};
  if (typeof parsed.ceilMode === "boolean") out.ceilMode = parsed.ceilMode;
  if (typeof parsed.binFusion === "boolean") out.binFusion = parsed.binFusion;
  if (typeof parsed.powerSustain === "boolean") {
    out.powerSustain = parsed.powerSustain;
  }
  if (typeof parsed.machinesPerVaporizer === "number") {
    out.machinesPerVaporizer = sanitizeMachinesPerVaporizer(
      parsed.machinesPerVaporizer,
    );
  }
  return out;
}

/**
 * Read the stored plan-option preferences. Returns `{}` on SSR, when
 * localStorage is unavailable, or when the payload is missing / corrupt
 * / of the wrong shape — the caller then falls back to the in-app
 * defaults, which is always a valid state.
 */
export function loadPlanOptions(): StoredPlanOptions {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PLAN_OPTIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return sanitize(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

/**
 * Persist ONE option, leaving the others untouched (read-modify-write).
 * Per-key rather than whole-object so that changing an option while
 * viewing someone else's link cannot also persist the values that link
 * supplied. Best-effort: silently no-ops on SSR or when localStorage is
 * disabled/full.
 */
export function savePlanOption<K extends keyof StoredPlanOptions>(
  key: K,
  value: NonNullable<StoredPlanOptions[K]>,
): void {
  if (typeof window === "undefined") return;
  try {
    const next: StoredPlanOptions = { ...loadPlanOptions(), [key]: value };
    window.localStorage.setItem(
      PLAN_OPTIONS_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // localStorage disabled / full — non-fatal, the option still applies
    // for this session.
  }
}
