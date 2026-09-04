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
 *
 * Loading a plan FILE is likewise not a setter call: `useProductionPlan`
 * applies a file's options through the raw state setters, so someone
 * else's saved plan cannot fold their four options into the opener's
 * preferences — and a legacy file that omits an option cannot store that
 * option's default as though it had been chosen.
 */

import { namespaceStorageKey } from "@/lib/storage-namespace";
import {
  DEFAULT_MACHINES_PER_VAPORIZER,
  sanitizeMachinesPerVaporizer,
} from "@/lib/sustain-constants";

const PLAN_OPTIONS_STORAGE_KEY = namespaceStorageKey(
  "endfield-calc:plan-options-v1",
);

/**
 * The four plan options, as the app holds them. Single declaration —
 * `PlanHashState` embeds it and the stored form below is its `Partial`,
 * so the URL and the preference store cannot drift apart on which
 * options exist.
 */
export interface PlanOptions {
  readonly ceilMode: boolean;
  readonly binFusion: boolean;
  readonly powerSustain: boolean;
  readonly machinesPerVaporizer: number;
}

/**
 * The in-app default for each option — the single place these values are
 * written down. `serializeHash` omits any option equal to its default
 * (which is what makes an absent URL param mean "default"), and
 * `parseHash` restores them, so a literal duplicated between the two
 * would silently change what every existing link means.
 */
export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  ceilMode: false,
  binFusion: true,
  powerSustain: false,
  machinesPerVaporizer: DEFAULT_MACHINES_PER_VAPORIZER,
};

/**
 * Persisted plan options. Every field is optional: a key is present only
 * once the user has actually set it, so an untouched option keeps
 * following the in-app default if that default ever changes.
 */
export type StoredPlanOptions = Partial<PlanOptions>;

/**
 * Per-option coercion from untrusted JSON — a TOTAL map over
 * `PlanOptions`, so adding a fifth option fails the build until it has a
 * validator here. Without that, a new option would silently never
 * persist. (Same maintenance-guard trick as `FIELD_ENCODERS` in
 * `plan-share-codec.ts`.)
 *
 * Each returns `undefined` to drop the value, which keeps the key absent
 * rather than pinning it to a wrong default.
 */
const VALIDATORS: {
  [K in keyof PlanOptions]: (raw: unknown) => PlanOptions[K] | undefined;
} = {
  ceilMode: (raw) => (typeof raw === "boolean" ? raw : undefined),
  binFusion: (raw) => (typeof raw === "boolean" ? raw : undefined),
  powerSustain: (raw) => (typeof raw === "boolean" ? raw : undefined),
  machinesPerVaporizer: (raw) =>
    typeof raw === "number" ? sanitizeMachinesPerVaporizer(raw) : undefined,
};

/** Coerce a parsed payload, dropping anything of the wrong shape. */
function sanitize(parsed: Record<string, unknown>): StoredPlanOptions {
  const out: { -readonly [K in keyof StoredPlanOptions]: StoredPlanOptions[K] } =
    {};
  for (const key of Object.keys(VALIDATORS) as (keyof PlanOptions)[]) {
    const value = VALIDATORS[key](parsed[key]);
    // Narrowing per key: the map's value type is keyed to `key`, but TS
    // can't track that through the loop, so assign through a union-safe
    // cast confined to this one line.
    if (value !== undefined) {
      (out[key] as PlanOptions[typeof key]) = value;
    }
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
