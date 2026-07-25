/**
 * Tests for `serializeHash` — the plan → hash-body writer.
 *
 * Covers the rule that a link is written ONLY for a plan that has at
 * least one target: options and the settings blob describe no plan on
 * their own, so an empty app must keep a clean, hash-less URL however
 * many toggles are flipped. The options survive a reload as preferences
 * instead (`plan-options-storage.ts`).
 *
 * The rest of the hook is not exercisable without DOM test infra, so
 * this covers the seam that is pure.
 */

import { describe, expect, test } from "vitest";

import { parseHash, serializeHash } from "@/hooks/useProductionPlan";
import { decodeHash, encodeHashToken } from "@/lib/plan-share-codec";
import { DEFAULT_MACHINES_PER_VAPORIZER } from "@/lib/sustain-constants";
import { encodeItemRef } from "@/lib/url-codes";
import { items } from "@/data";
import type { ItemId, RecipeId } from "@/types";

const someItem = items[0].id;
const BLOB = "0D2";

/** `serializeHash` with every option at its default. */
function serialize(
  overrides: Partial<{
    targets: { itemId: ItemId; rate: number; locked?: boolean }[];
    recipeOverrides: Map<ItemId, RecipeId>;
    manualRawMaterials: Set<ItemId>;
    ceilMode: boolean;
    binFusion: boolean;
    powerSustain: boolean;
    machinesPerVaporizer: number;
    shareBlob: string;
  }> = {},
) {
  return serializeHash(
    overrides.targets ?? [],
    overrides.recipeOverrides ?? new Map(),
    overrides.manualRawMaterials ?? new Set(),
    overrides.ceilMode ?? false,
    overrides.binFusion ?? true,
    overrides.powerSustain ?? false,
    overrides.machinesPerVaporizer ?? DEFAULT_MACHINES_PER_VAPORIZER,
    overrides.shareBlob ?? BLOB,
  );
}

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
        recipeOverrides: new Map([[someItem, "whatever" as RecipeId]]),
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
