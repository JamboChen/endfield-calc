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
 * shape** (`DEFAULT_PERSISTED_SHAPE`): only fields the sharer actually
 * customized are emitted, so a default user's delta is empty. Each
 * present field is serialized to a short, chat-safe string (NOT JSON):
 * fields are delimited by their uppercase letter (all ids/values are
 * lowercase `[a-z0-9_.]`, so no separator is needed between them) and
 * `~` separates everything inside a field. Only the universal `domain_`
 * / `tech_` prefixes are stripped; item/facility/structure ids stay
 * full. The whole thing is prefixed `0` (raw) or `1` (lz-compressed),
 * whichever is shorter — lz only wins for large deltas (many
 * unresearched techs), where a plain JSON payload used to LOSE to
 * lz-string's own base64 overhead.
 *
 * Both sides compute the same default baseline + strip/format rules
 * (same app/data version), so the delta round-trips exactly; decoding
 * always ends at `sanitizePersistedShape`, so a cross-version blob
 * degrades gracefully (unknown ids dropped, unknown field letters
 * skipped).
 *
 * # URL transport
 *
 * The blob is appended to / read from the hash manually (`withShareBlob`
 * / `readShareBlobFromHash`), NOT via `URLSearchParams` — the `0`-form
 * uses `~` (fine) and the `1`-form's `compressToEncodedURIComponent`
 * output can contain `+`, which `URLSearchParams` would mangle (→
 * space). Both alphabets are valid unencoded in a fragment (RFC 3986),
 * so they survive copy-paste.
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

// ── Compact serialization ──────────────────────────────────────────────────

type DeltaKey = (typeof DELTA_KEYS)[number];

const DOMAIN_PREFIX = "domain_";
const TECH_PREFIX = "tech_";
/** Metastorage route-mode marker for "disabled" (guaranteed not a domain
 *  suffix — see the `plan-share-codec.test.ts` marker invariant). */
const DISABLED_MARK = "x";

const stripDomain = (id: string): string => id.slice(DOMAIN_PREFIX.length);
const stripTech = (id: string): string => id.slice(TECH_PREFIX.length);
const withDomain = (s: string): string => DOMAIN_PREFIX + s;
const withTech = (s: string): string => TECH_PREFIX + s;

/**
 * Per-field encoders — a TOTAL map over `DeltaKey`, so adding a new
 * settings category to `DELTA_KEYS` fails the build until it has an
 * encoder here (the maintenance guard). Each returns one `<Letter>…`
 * field string.
 */
const FIELD_ENCODERS: Record<DeltaKey, (c: PersistedShape) => string> = {
  domains: (c) =>
    "D" +
    [
      c.domains.current ? stripDomain(c.domains.current) : "",
      ...c.domains.inactive.map(stripDomain),
    ].join("~"),
  aic: (c) => {
    const techs = c.aic.unresearched.map(stripTech);
    const caps = c.aic.capOverrides.flatMap((o) => [
      o.facilityId,
      stripDomain(o.domainId),
      String(o.value),
    ]);
    return "A" + [String(techs.length), ...techs, ...caps].join("~");
  },
  rawLimits: (c) =>
    "R" +
    (c.rawLimits?.overrides ?? [])
      .flatMap((o) => [o.itemId, stripDomain(o.domainId), String(o.value)])
      .join("~"),
  structures: (c) =>
    "S" +
    (c.structures?.disabled ?? [])
      .flatMap((d) => [d.structureId, stripDomain(d.domainId)])
      .join("~"),
  metastorage: (c) =>
    "M" +
    (c.metastorage?.routes ?? [])
      .flatMap((r) => [
        stripDomain(r.source),
        r.mode === "disabled" ? DISABLED_MARK : stripDomain(r.mode),
      ])
      .join("~"),
};

/** Split a field payload into `~`-tokens (empty payload → no tokens). */
const splitField = (payload: string): string[] =>
  payload === "" ? [] : payload.split("~");

/**
 * Per-field decoders keyed by field letter; each writes one delta field
 * into `out` (a loose, pre-sanitize shape). Unknown letters are skipped
 * by the caller for forward-compatibility.
 */
const FIELD_DECODERS: Record<
  string,
  (payload: string, out: Record<string, unknown>) => void
> = {
  D: (p, out) => {
    const [cur, ...inactive] = splitField(p);
    out.domains = {
      current: cur ? withDomain(cur) : undefined,
      inactive: inactive.map(withDomain),
    };
  },
  A: (p, out) => {
    const t = splitField(p);
    const n = Number(t[0] ?? "0");
    const unresearched = t.slice(1, 1 + n).map(withTech);
    const rest = t.slice(1 + n);
    const capOverrides: unknown[] = [];
    for (let i = 0; i + 3 <= rest.length; i += 3) {
      capOverrides.push({
        facilityId: rest[i],
        domainId: withDomain(rest[i + 1]),
        value: Number(rest[i + 2]),
      });
    }
    out.aic = { unresearched, capOverrides };
  },
  R: (p, out) => {
    const t = splitField(p);
    const overrides: unknown[] = [];
    for (let i = 0; i + 3 <= t.length; i += 3) {
      overrides.push({
        itemId: t[i],
        domainId: withDomain(t[i + 1]),
        value: Number(t[i + 2]),
      });
    }
    out.rawLimits = { overrides };
  },
  S: (p, out) => {
    const t = splitField(p);
    const disabled: unknown[] = [];
    for (let i = 0; i + 2 <= t.length; i += 2) {
      disabled.push({ structureId: t[i], domainId: withDomain(t[i + 1]) });
    }
    out.structures = { disabled };
  },
  M: (p, out) => {
    const t = splitField(p);
    const routes: unknown[] = [];
    for (let i = 0; i + 2 <= t.length; i += 2) {
      routes.push({
        source: withDomain(t[i]),
        mode: t[i + 1] === DISABLED_MARK ? "disabled" : withDomain(t[i + 1]),
      });
    }
    out.metastorage = { routes };
  },
};

/** Serialize the present (differ-from-default) fields to the raw compact form. */
function encodeCompact(canonical: PersistedShape): string {
  let out = "";
  for (const key of DELTA_KEYS) {
    if (
      JSON.stringify(canonical[key]) !==
      JSON.stringify(DEFAULT_PERSISTED_SHAPE[key])
    ) {
      out += FIELD_ENCODERS[key](canonical);
    }
  }
  return out;
}

/** Parse the raw compact form back into a partial (pre-sanitize) shape. */
function decodeCompact(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of raw.match(/[A-Z][^A-Z]*/g) ?? []) {
    FIELD_DECODERS[field[0]]?.(field.slice(1), out); // unknown letter → skip
  }
  return out;
}

/**
 * Encode a settings snapshot into the compact `s=` blob value. Input is
 * sanitized + canonicalized first, so any channel (live settings, a
 * hand-edited saved file) yields the same output for the same effective
 * settings. Fields equal to the first-run default are omitted; the whole
 * thing is prefixed `0` (raw) or `1` (lz), whichever is shorter.
 */
export function encodeSettingsSnapshot(shape: PersistedShape): string {
  try {
    const compact = encodeCompact(
      canonicalizeShape(
        sanitizePersistedShape(shape) ?? DEFAULT_PERSISTED_SHAPE,
      ),
    );
    const raw = "0" + compact;
    const packed = "1" + compressToEncodedURIComponent(compact);
    return raw.length <= packed.length ? raw : packed;
  } catch {
    // Runs inside a render-time `useMemo` (the URL `s=` sync). Never
    // break the render over a settings-encode failure — degrade to a
    // settings-less hash; the decode side then falls back to the
    // viewer's own settings.
    return "";
  }
}

/**
 * Decode an `s=` blob back into a clean `PersistedShape`. Reads the
 * format flag, reconstructs the delta, overlays it on the default
 * baseline, then sanitizes. Returns `null` for empty / corrupt /
 * unrecognized-format input (caller falls back to own settings).
 */
export function decodeSettingsSnapshot(blob: string): PersistedShape | null {
  try {
    if (!blob) return null;
    const rest = blob.slice(1);
    let compact: string | null;
    if (blob[0] === "1") {
      // lz-string's typings understate the null-on-malformed case.
      compact = decompressFromEncodedURIComponent(rest);
    } else if (blob[0] === "0") {
      compact = rest;
    } else {
      return null; // unrecognized format flag (e.g. a pre-format blob)
    }
    if (compact == null) return null;
    return sanitizePersistedShape({
      ...DEFAULT_PERSISTED_SHAPE,
      ...decodeCompact(compact),
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
