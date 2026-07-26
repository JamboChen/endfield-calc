/**
 * The plan ⇄ URL layer: everything that turns a plan into a shareable
 * link and back. Pure — no React — so the whole round trip is testable
 * (`plan-hash.test.ts`).
 *
 * Three stages, outermost first:
 *
 *   `#0dD0zOjY…`          the opaque token the address bar shows
 *     └ `encodeHashToken` / `decodeHash`
 *   `t=s:6&c=1&s=0D2A0`   the hash body: plan params + settings blob
 *     └ `serializeHash` / `parseHash`
 *   `PlanHashState`       the plan itself
 *
 * The settings blob (`s=`) is opaque here; `plan-share-codec.ts` owns
 * its contents and this module only carries it through.
 */

import type { ProductionTarget } from "@/components/panels/TargetItemsGrid";
import { MAX_TARGETS } from "@/data";
import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";
import {
  DEFAULT_PLAN_OPTIONS,
  loadPlanOptions,
  type PlanOptions,
} from "@/lib/plan-options-storage";
import { withShareBlob } from "@/lib/plan-share-codec";
import {
  DEFAULT_MACHINES_PER_VAPORIZER,
  sanitizeMachinesPerVaporizer,
} from "@/lib/sustain-constants";
import {
  decodeItemRef,
  decodeRecipeRef,
  encodeItemRef,
  encodeRecipeRef,
} from "@/lib/url-codes";
import type { ItemId, RecipeId } from "@/types";

/**
 * A complete plan as the URL carries it — what `parseHash` reads out and
 * what `serializeHash` writes back, so the two are provable inverses
 * (`plan-hash.test.ts` round-trips them). Naming the fields also removes
 * the swap hazard three adjacent boolean parameters used to carry.
 */
export interface PlanHashState extends PlanOptions {
  targets: ProductionTarget[];
  recipeOverrides: Map<ItemId, RecipeId>;
  manualRawMaterials: Set<ItemId>;
}

// ── Token layer ────────────────────────────────────────────────────────────

/**
 * Wrap a full hash body into the single opaque token the address bar
 * shows, prefixed with a 1-char format flag:
 *
 *   `0` + base64url  — `A-Za-z0-9-_`, padding stripped
 *   `1` + lz-string  — `A-Za-z0-9+-$` (`compressToEncodedURIComponent`)
 *
 * Whichever is shorter wins. Both alphabets are valid unencoded in a
 * fragment (RFC 3986) so they survive copy-paste, and neither contains
 * `=` or `&`, which is what lets `decodeHash` recognize the legacy
 * readable form.
 *
 * This is the ONLY place compression happens. Doing it here rather than
 * inside the `s=` blob matters: base64url costs a flat +33%, so
 * compressing further in and then base64-ing the result inflated the
 * compressed bytes right back (measured 370 → 524 chars on a realistic
 * payload). One decision, taken where the final URL length is visible.
 *
 * Empty in → empty out, so an empty app keeps a clean, hash-less URL.
 *
 * `btoa` is safe here: every producer of the inner string emits ASCII
 * only (ids are base36 codes or `[a-z0-9_]`, rates `[0-9.]`), which
 * `plan-hash.test.ts` asserts directly.
 */
export function encodeHashToken(inner: string): string {
  if (!inner) return "";
  const packed = compressToEncodedURIComponent(inner);
  const base64 = btoa(inner)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return base64.length <= packed.length ? "0" + base64 : "1" + packed;
}

/**
 * Unwrap a location hash into the inner `t=…&r=…&s=…` body that the
 * parsers consume. The inverse of `encodeHashToken`, plus back-compat.
 *
 * Legacy readable links (`#t=item_steel:6`) are passed through untouched:
 * every parameter is a `k=v` pair, so a legacy body always contains `=`,
 * while the token alphabet contains neither `=` nor `&`. That keeps every
 * link shared before tokenization working — and doubles as an escape
 * hatch, since a hand-written readable hash is still accepted.
 *
 * Never throws: a corrupt token (truncated, or a stray `#anchor`) yields
 * `""`, which the callers read as "no plan" rather than erroring.
 */
export function decodeHash(hash: string): string {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!body) return "";
  if (body.includes("=") || body.includes("&")) return body; // legacy
  try {
    const payload = body.slice(1);
    if (body[0] === "1") {
      return decompressFromEncodedURIComponent(payload) ?? "";
    }
    if (body[0] !== "0") return ""; // unrecognized format flag
    const base64 =
      payload.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (payload.length % 4)) % 4);
    return atob(base64);
  } catch {
    return "";
  }
}

// ── Hash body ⇄ plan state ─────────────────────────────────────────────────

/**
 * A target-less plan carrying the user's stored option preferences —
 * what a hash-less visit ("this is my app") starts from.
 *
 * Preferences apply ONLY here. A hash means "render exactly this plan
 * state", and since `serializeHash` omits default-valued options, an
 * absent param there means the sharer had the default — so the parsed
 * branch must never consult them, or a shared plan would compute against
 * the viewer's options. See `plan-options-storage.ts`.
 */
function preferredEmptyState(): PlanHashState {
  const preferred = loadPlanOptions();
  return {
    targets: [],
    recipeOverrides: new Map(),
    manualRawMaterials: new Set(),
    ...DEFAULT_PLAN_OPTIONS,
    ...preferred,
  };
}

/**
 * Read a plan state out of a location hash. Defaults to the live URL;
 * the hashchange handler passes an explicit hash to decide whether an
 * externally-pasted link actually carries a plan.
 *
 * Never throws — anything unparseable degrades to the target-less
 * default state.
 */
export function parseHash(
  rawHash: string = typeof window === "undefined" ? "" : window.location.hash,
): PlanHashState {
  try {
    // Unwraps the opaque token (or passes a legacy readable hash
    // through) — see `decodeHash`.
    const hash = decodeHash(rawHash);
    if (!hash) return preferredEmptyState();

    const params = new URLSearchParams(hash);

    // Parse targets: t=item_steel:6,item_glass:3
    // A trailing `l` on the rate marks the target as locked
    // (t=item_steel:6l). Backward AND forward compatible: old URLs have
    // no suffix (= unlocked), and old app versions reading a new URL
    // still get the rate via parseFloat("6l") === 6, merely dropping
    // the flag.
    const targetsRaw = params.get("t");
    const parsedTargets: ProductionTarget[] = [];
    if (targetsRaw) {
      for (const part of targetsRaw.split(",")) {
        const colonIdx = part.lastIndexOf(":");
        if (colonIdx === -1) continue;
        const itemId = decodeItemRef(part.slice(0, colonIdx));
        const rateStr = part.slice(colonIdx + 1);
        const locked = rateStr.endsWith("l");
        const rate = parseFloat(rateStr);
        if (itemId && isFinite(rate) && rate >= 0) {
          parsedTargets.push(
            locked ? { itemId, rate, locked: true } : { itemId, rate },
          );
        }
      }
    }

    // Parse recipeOverrides: r=<item>:<recipe> (both short codes)
    const recipeRaw = params.get("r");
    const parsedRecipeOverrides = new Map<ItemId, RecipeId>();
    if (recipeRaw) {
      for (const part of recipeRaw.split(",")) {
        const colonIdx = part.indexOf(":");
        if (colonIdx === -1) continue;
        const itemId = decodeItemRef(part.slice(0, colonIdx));
        // Resolves a code or a legacy full id, and doubles as the
        // existence check (unknown → null → the pin is dropped).
        const recipeId = decodeRecipeRef(part.slice(colonIdx + 1));
        if (itemId && recipeId) {
          parsedRecipeOverrides.set(itemId, recipeId);
        }
      }
    }

    // Parse manualRawMaterials: m=item_coal,item_wood
    const manualRaw = params.get("m");
    const parsedManualRawMaterials = new Set<ItemId>();
    if (manualRaw) {
      for (const rawId of manualRaw.split(",")) {
        const itemId = decodeItemRef(rawId);
        if (itemId) {
          parsedManualRawMaterials.add(itemId);
        }
      }
    }

    // Parse machinesPerVaporizer: mpv=N.
    const mpvRaw = params.get("mpv");

    return {
      // A link is an untrusted artifact pasted from strangers, so hold
      // it to the same ceiling the UI enforces on its own add path —
      // otherwise a crafted link puts the app in a state it forbids.
      targets: parsedTargets.slice(0, MAX_TARGETS),
      recipeOverrides: parsedRecipeOverrides,
      manualRawMaterials: parsedManualRawMaterials,
      // Each option is emitted only when it differs from its default, so
      // an absent param means "default" — never "unspecified".
      ceilMode: params.get("c") === "1",
      binFusion: params.get("bf") !== "0",
      powerSustain: params.get("ps") === "1",
      machinesPerVaporizer:
        mpvRaw !== null
          ? sanitizeMachinesPerVaporizer(parseFloat(mpvRaw))
          : DEFAULT_MACHINES_PER_VAPORIZER,
    };
  } catch {
    return preferredEmptyState();
  }
}

/**
 * Build the hash body for a plan state (before `encodeHashToken` wraps
 * it) — the exact inverse of `parseHash`.
 *
 * Returns `""` for a target-less plan, which keeps the URL clean.
 */
export function serializeHash(
  state: PlanHashState,
  shareBlob: string,
): string {
  const {
    targets,
    recipeOverrides,
    manualRawMaterials,
    ceilMode,
    binFusion,
    powerSustain,
    machinesPerVaporizer,
  } = state;

  // No target, no link. Options and the settings blob describe no plan
  // on their own, so writing them would leave a long opaque hash on an
  // empty app — and the options survive a reload as preferences anyway
  // (`plan-options-storage.ts`), so nothing is lost by omitting them.
  if (targets.length === 0) return "";

  const params = new URLSearchParams();

  params.set(
    "t",
    targets
      .map((t) => `${encodeItemRef(t.itemId)}:${t.rate}${t.locked ? "l" : ""}`)
      .join(","),
  );

  if (recipeOverrides.size > 0) {
    params.set(
      "r",
      Array.from(recipeOverrides.entries())
        .map(
          ([itemId, recipeId]) =>
            `${encodeItemRef(itemId)}:${encodeRecipeRef(recipeId)}`,
        )
        .join(","),
    );
  }

  if (manualRawMaterials.size > 0) {
    params.set("m", Array.from(manualRawMaterials, encodeItemRef).join(","));
  }

  // Options are emitted ONLY when they differ from the default — that is
  // what keeps a link short, and what makes an absent param mean "the
  // sharer had the default" on the way back in.
  if (ceilMode !== DEFAULT_PLAN_OPTIONS.ceilMode) params.set("c", "1");
  if (binFusion !== DEFAULT_PLAN_OPTIONS.binFusion) params.set("bf", "0");
  if (powerSustain !== DEFAULT_PLAN_OPTIONS.powerSustain) params.set("ps", "1");
  if (machinesPerVaporizer !== DEFAULT_PLAN_OPTIONS.machinesPerVaporizer) {
    params.set("mpv", String(machinesPerVaporizer));
  }

  // `:` and `,` (the only chars URLSearchParams encodes in t/r/m — item/
  // recipe ids are `[a-z0-9_]`, rates `[0-9.]`) are valid unencoded in a
  // fragment, so raw-ify them for shorter, readable plan params.
  // `parseHash` reads via `URLSearchParams.get`, which accepts both the
  // raw and legacy `%3A`/`%2C` forms.
  const base = params.toString().replace(/%3A/g, ":").replace(/%2C/g, ",");
  return withShareBlob(base, shareBlob);
}
