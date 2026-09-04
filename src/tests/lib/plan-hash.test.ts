/**
 * Tests for the plan ⇄ URL layer (`src/lib/plan-url.ts`): the token
 * wrapper, the hash body, and the round trip between them.
 *
 * Three rules carry most of the weight:
 *   - a link is written ONLY for a plan with at least one target, so an
 *     empty app keeps a clean URL however many toggles are flipped;
 *   - `parseHash` and `serializeHash` are inverses, verified as a
 *     property rather than field by field;
 *   - stored option preferences apply on a hash-less visit and NEVER to
 *     a link, since an absent param there means "the sharer had the
 *     default".
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  decodeHash,
  encodeHashToken,
  parseHash,
  serializeHash,
  type PlanHashState,
} from "@/lib/plan-url";
import { DEFAULT_PLAN_OPTIONS } from "@/lib/plan-options-storage";
import { encodeItemRef } from "@/lib/url-codes";
import { items, recipes, MAX_TARGETS } from "@/data";
import { stubLocalStorage } from "./fake-storage";

const someItem = items[0].id;
const otherItem = items[1].id;
const someRecipe = recipes[0].id;
const BLOB = "0D2";

/** A plan state with every option at its default. */
function state(overrides: Partial<PlanHashState> = {}): PlanHashState {
  return {
    targets: [],
    recipeOverrides: new Map(),
    manualRawMaterials: new Set(),
    ...DEFAULT_PLAN_OPTIONS,
    ...overrides,
  };
}

const serialize = (
  overrides: Partial<PlanHashState> & { shareBlob?: string } = {},
) => serializeHash(state(overrides), overrides.shareBlob ?? BLOB);

describe("serializeHash — a link needs a target", () => {
  test("no targets → no hash, even with a settings blob", () => {
    expect(serialize()).toBe("");
  });

  test("no targets → no hash, whatever the options are", () => {
    // The regression: these flags used to make the hash non-empty on
    // their own, which dragged the whole settings blob into the URL of
    // an empty app.
    expect(serialize({ ceilMode: true })).toBe("");
    expect(serialize({ binFusion: false })).toBe("");
    expect(serialize({ powerSustain: true })).toBe("");
    expect(serialize({ machinesPerVaporizer: 8 })).toBe("");
    expect(
      serialize({
        ceilMode: true,
        binFusion: false,
        powerSustain: true,
        machinesPerVaporizer: 8,
      }),
    ).toBe("");
  });

  test("no targets → no hash, even with pins or manual raws", () => {
    // Both are meaningless without a plan to apply them to.
    expect(
      serialize({
        recipeOverrides: new Map([[someItem, someRecipe]]),
        manualRawMaterials: new Set([someItem]),
      }),
    ).toBe("");
  });

  test("one target → the hash carries the plan and the settings blob", () => {
    const hash = serialize({ targets: [{ itemId: someItem, rate: 6 }] });
    expect(hash).toBe(`t=${encodeItemRef(someItem)}:6&s=${BLOB}`);
  });

  test("options ride along once there is a target", () => {
    const hash = serialize({
      targets: [{ itemId: someItem, rate: 6 }],
      ceilMode: true,
      binFusion: false,
      powerSustain: true,
      machinesPerVaporizer: 8,
    });
    for (const param of ["c=1", "bf=0", "ps=1", "mpv=8"]) {
      expect(hash).toContain(param);
    }
  });

  test("an empty settings blob still yields a plan hash", () => {
    // `encodeSettingsSnapshot` degrades to "" if it ever throws; the
    // plan itself must survive that.
    const hash = serialize({
      targets: [{ itemId: someItem, rate: 6 }],
      shareBlob: "",
    });
    expect(hash).toBe(`t=${encodeItemRef(someItem)}:6`);
  });

  test("a locked target keeps its `l` marker through the token", () => {
    const hash = serialize({
      targets: [{ itemId: someItem, rate: 6, locked: true }],
    });
    expect(hash).toContain(`${encodeItemRef(someItem)}:6l`);
    expect(decodeHash(encodeHashToken(hash))).toBe(hash);
  });

  test("an empty hash tokenizes to nothing (no '#' in the URL)", () => {
    expect(encodeHashToken(serialize())).toBe("");
  });
});

describe("round-trip — parseHash and serializeHash are inverses", () => {
  // The property that matters: whatever the app writes, it reads back
  // identically THROUGH the token layer. Because both sides now speak
  // `PlanHashState`, this catches drift between them — a field added to
  // one and forgotten in the other fails here, which per-field
  // assertions could never do.
  const roundTrip = (input: PlanHashState): PlanHashState =>
    parseHash(`#${encodeHashToken(serializeHash(input, BLOB))}`);

  const CASES: Record<string, PlanHashState> = {
    "a single target": state({ targets: [{ itemId: someItem, rate: 6 }] }),
    "a fractional rate": state({
      targets: [{ itemId: someItem, rate: 14.75 }],
    }),
    "a locked target": state({
      targets: [{ itemId: someItem, rate: 6, locked: true }],
    }),
    "mixed locked and unlocked": state({
      targets: [
        { itemId: someItem, rate: 6, locked: true },
        { itemId: otherItem, rate: 3 },
      ],
    }),
    "a recipe pin": state({
      targets: [{ itemId: someItem, rate: 6 }],
      recipeOverrides: new Map([[someItem, someRecipe]]),
    }),
    "a manual raw": state({
      targets: [{ itemId: someItem, rate: 6 }],
      manualRawMaterials: new Set([otherItem]),
    }),
    "every option flipped off-default": state({
      targets: [{ itemId: someItem, rate: 6 }],
      ceilMode: true,
      binFusion: false,
      powerSustain: true,
      machinesPerVaporizer: 9,
    }),
    "everything at once": state({
      targets: [
        { itemId: someItem, rate: 14.75, locked: true },
        { itemId: otherItem, rate: 3 },
      ],
      recipeOverrides: new Map([[someItem, someRecipe]]),
      manualRawMaterials: new Set([otherItem]),
      ceilMode: true,
      binFusion: false,
      powerSustain: true,
      machinesPerVaporizer: 16,
    }),
  };

  test.each(Object.keys(CASES))("%s survives the round trip", (name) => {
    const input = CASES[name];
    expect(roundTrip(input)).toEqual(input);
  });

  test("re-serializing the parsed state reproduces the same hash", () => {
    // Stability: reading a link and writing it back must not churn the
    // URL, or the URL-sync effect would rewrite every shared link on open.
    const input = CASES["everything at once"];
    const hash = serializeHash(input, BLOB);
    expect(serializeHash(parseHash(`#${encodeHashToken(hash)}`), BLOB)).toBe(
      hash,
    );
  });
});

describe("parseHash — the pasted-link guard", () => {
  // The hashchange handler loads a pasted link only when this yields at
  // least one target; anything else leaves the open plan alone and warns.
  const targetCount = (hash: string) => parseHash(hash).targets.length;

  test("accepts a real plan link, with or without the '#'", () => {
    const token = encodeHashToken(
      serialize({ targets: [{ itemId: someItem, rate: 6 }] }),
    );
    expect(targetCount(`#${token}`)).toBe(1);
    expect(targetCount(token)).toBe(1);
  });

  test("accepts a legacy readable hash", () => {
    expect(targetCount(`#t=${encodeItemRef(someItem)}:6`)).toBe(1);
  });

  test("rejects an empty hash", () => {
    expect(targetCount("")).toBe(0);
    expect(targetCount("#")).toBe(0);
  });

  test("rejects a hash with options but no plan", () => {
    expect(targetCount("#c=1&bf=0&ps=1")).toBe(0);
  });

  test("rejects a settings-only hash", () => {
    expect(targetCount("#s=0D2")).toBe(0);
  });

  test("rejects a corrupt or truncated token", () => {
    const token = encodeHashToken(
      serialize({ targets: [{ itemId: someItem, rate: 6 }] }),
    );
    expect(targetCount("#!!!not-base64!!!")).toBe(0);
    // Truncation must never resolve to a bogus plan or throw.
    for (let i = 1; i < token.length; i++) {
      expect(() => targetCount(`#${token.slice(0, i)}`)).not.toThrow();
    }
  });

  test("rejects a link whose targets don't resolve to real items", () => {
    // Guards the case a `t=` presence check would wave through: the
    // param is there, but nothing in it decodes, so loading it would
    // blank the user's plan for nothing.
    expect(targetCount("#t=zzzzzz:6")).toBe(0);
    expect(targetCount("#t=not_an_item:6")).toBe(0);
  });

  test("rejects malformed target rates", () => {
    expect(targetCount(`#t=${encodeItemRef(someItem)}`)).toBe(0);
    expect(targetCount(`#t=${encodeItemRef(someItem)}:abc`)).toBe(0);
    expect(targetCount(`#t=${encodeItemRef(someItem)}:-5`)).toBe(0);
  });
});

describe("hash token (encodeHashToken / decodeHash)", () => {
  test("round-trips an arbitrary hash body", () => {
    const inner = "t=s:14.4l,5h:24l&c=1&s=0Dvalley~A3~a~b~c";
    const token = encodeHashToken(inner);
    expect(token).not.toBe(inner);
    expect(decodeHash(token)).toBe(inner);
    expect(decodeHash("#" + token)).toBe(inner);
  });

  test("the token stays fragment-safe and legacy-distinguishable", () => {
    // Contract, not alphabet: either branch may win, so assert what
    // actually matters. `=`/`&` would collide with the legacy-form
    // detection, and anything outside the RFC 3986 fragment set would
    // get percent-escaped on copy-paste and break the link.
    for (const inner of [
      "t=s:14.4l",
      "t=s:1,5h:2,5a:3&r=s:4r&m=3a&c=1&bf=0&ps=1&mpv=6",
      "s=0D1A3~0~1~2",
      "t=" + "s:1,".repeat(50), // compressible → the lz branch wins
    ]) {
      const token = encodeHashToken(inner);
      expect(token).toMatch(/^[01]/); // format flag
      expect(token).toMatch(/^[A-Za-z0-9_+$-]+$/); // base64url ∪ lz-string
      expect(token).not.toMatch(/[=&#%/]/);
      expect(decodeHash(token)).toBe(inner);
    }
  });

  test("picks the shorter of the two encodings", () => {
    const compressible = "t=" + "s:1,".repeat(50);
    expect(encodeHashToken(compressible)[0]).toBe("1");
    // Short and high-entropy: base64url wins, since lz-string has a
    // fixed startup cost it cannot amortize.
    expect(encodeHashToken("t=s:14.4l")[0]).toBe("0");
  });

  test("legacy readable hashes pass through untouched (back-compat)", () => {
    // Links shared before tokenization — every param is `k=v`, so the
    // body always contains '='.
    expect(decodeHash("#t=item_steel:6")).toBe("t=item_steel:6");
    expect(decodeHash("#t=item_steel:6&c=1")).toBe("t=item_steel:6&c=1");
    expect(decodeHash("t=item_steel:6&s=0Dvalley")).toBe(
      "t=item_steel:6&s=0Dvalley",
    );
  });

  test("empty in → empty out (an empty plan keeps a hash-less URL)", () => {
    expect(encodeHashToken("")).toBe("");
    expect(decodeHash("")).toBe("");
    expect(decodeHash("#")).toBe("");
  });

  test("a corrupt token decodes to '' instead of throwing", () => {
    // Truncated / mangled by a chat client, or a plain '#anchor'.
    expect(() => decodeHash("#!!!not-base64!!!")).not.toThrow();
    expect(decodeHash("#!!!not-base64!!!")).toBe("");
    const token = encodeHashToken("t=s:14.4l&c=1");
    // Any truncation must degrade, never throw.
    for (let i = 1; i < token.length; i++) {
      expect(() => decodeHash("#" + token.slice(0, i))).not.toThrow();
    }
  });

  test("a token is shorter than a URL-encoded readable hash would be", () => {
    // The point of the wrapper is cosmetic, but it must not blow the
    // URL up either: base64url costs ~33%, which stays well under what
    // percent-encoding the same string would cost.
    const inner = "t=s:14.4l,5h:24l,5a:14.75&c=1&s=0Dvalley";
    expect(encodeHashToken(inner).length).toBeLessThan(
      encodeURIComponent(inner).length,
    );
  });
});

describe("option preferences apply to a hash-less visit only", () => {
  // The rule this protects: `serializeHash` omits default-valued
  // options, so an absent param inside a link means "the sharer had the
  // default". Consulting the viewer's preferences on that path would
  // reproduce a shared plan with the WRONG options — silently. Without a
  // `window`, `loadPlanOptions` returns `{}` and this whole rule is
  // invisible, so the fake store is the point of these tests.
  const stubStoredOptions = (stored: Record<string, unknown>) =>
    stubLocalStorage({
      "endfield-calc:plan-options-v1": JSON.stringify(stored),
    });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const NON_DEFAULT = {
    ceilMode: true,
    binFusion: false,
    powerSustain: true,
    machinesPerVaporizer: 9,
  };

  test("no hash → preferences win over the in-app defaults", () => {
    stubStoredOptions(NON_DEFAULT);
    expect(parseHash("")).toMatchObject(NON_DEFAULT);
  });

  test("a hash → the URL wins wholly, preferences are ignored", () => {
    stubStoredOptions(NON_DEFAULT);
    // A link whose sharer had every option at its default emits no
    // option params at all. The result must be the defaults, NOT the
    // viewer's stored preferences.
    const link = encodeHashToken(
      serializeHash(state({ targets: [{ itemId: someItem, rate: 6 }] }), BLOB),
    );
    expect(parseHash(`#${link}`)).toMatchObject(DEFAULT_PLAN_OPTIONS);
  });

  test("a hash overrides preferences per option, not just in bulk", () => {
    stubStoredOptions(NON_DEFAULT);
    const link = encodeHashToken(
      serializeHash(
        state({
          targets: [{ itemId: someItem, rate: 6 }],
          ceilMode: true, // matches the preference
          // the other three stay default and must NOT pick up the prefs
        }),
        BLOB,
      ),
    );
    expect(parseHash(`#${link}`)).toMatchObject({
      ceilMode: true,
      binFusion: DEFAULT_PLAN_OPTIONS.binFusion,
      powerSustain: DEFAULT_PLAN_OPTIONS.powerSustain,
      machinesPerVaporizer: DEFAULT_PLAN_OPTIONS.machinesPerVaporizer,
    });
  });

  test("a corrupt hash falls back to preferences, not to a broken plan", () => {
    stubStoredOptions(NON_DEFAULT);
    expect(parseHash("#0!!!not-base64!!!")).toMatchObject(NON_DEFAULT);
  });
});

describe("untrusted links are clamped to the UI's own ceiling", () => {
  test("more targets than MAX_TARGETS are truncated", () => {
    const many = Array.from({ length: MAX_TARGETS + 5 }, (_, i) => ({
      itemId: items[i % items.length].id,
      rate: 1,
    }));
    // Build the param by hand: `serializeHash` would faithfully emit all
    // of them, and it's the READ side that has to defend the app.
    const raw = `t=${many.map((t) => `${encodeItemRef(t.itemId)}:${t.rate}`).join(",")}`;
    expect(parseHash(`#${encodeHashToken(raw)}`).targets.length).toBe(
      MAX_TARGETS,
    );
  });
});
