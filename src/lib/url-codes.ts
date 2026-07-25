/**
 * Short, stable reference codes for shareable URLs.
 *
 * Game-data ids are long — items ~18 chars (`item_copper_enr2_cmpt`),
 * recipes up to 59 (`fluid_consume_liquid_cleaner_1_item_liquid_…`), AIC
 * techs ~22 — and they dominate the length of both the plan params
 * (`t=`/`r=`/`m=`) and the settings blob (`s=`'s raw limits, cap
 * overrides, structures, unresearched techs). This maps each id to a 1–2
 * char base36 code from the append-only registries in
 * `src/data/{item,recipe,facility,structure,tech}-codes.ts` (code = the
 * entry's array index in base36). The registries are stable forever — see
 * `gen-url-codes.ts` — so codes in already-shared URLs never change
 * meaning.
 *
 * Decoding is backward-compatible: a token is resolved as a full id
 * (links shared before codes existed) OR a code, so old plan URLs keep
 * working.
 *
 * Codes are lowercase `[0-9a-z]`, which also keeps them legal inside the
 * settings blob, where an uppercase letter delimits fields (see
 * `plan-share-codec.ts`).
 */

import { facilities, items, recipes, regionStructures } from "@/data";
import { aicNodes } from "@/data/aic-plans";
import { facilityCodeTable } from "@/data/facility-codes";
import { itemCodeTable } from "@/data/item-codes";
import { recipeCodeTable } from "@/data/recipe-codes";
import { structureCodeTable } from "@/data/structure-codes";
import { techCodeTable } from "@/data/tech-codes";
import type { AicTechId } from "@/types/aic";
import type { FacilityId, ItemId, RecipeId, RegionStructureId } from "@/types";

interface RefCodec<T extends string> {
  /**
   * Id → its short URL code. Falls back to the full id if the id somehow
   * has no code (the `url-codes.test.ts` completeness guard prevents this
   * in practice); the fallback is still decodable.
   */
  readonly encode: (id: T) => string;
  /**
   * Resolve a URL token to an id. Accepts BOTH a full id (legacy links +
   * the fallback above) and a short code (new links). `null` when neither
   * is known — the caller drops the reference.
   */
  readonly decode: (token: string) => T | null;
}

/**
 * Build a codec from an append-only registry plus the ids that actually
 * exist at runtime. `knownIds` is the source of truth for existence, so
 * tombstoned / stale registry entries resolve to nothing and are skipped.
 */
function makeRefCodec<T extends string>(
  table: readonly string[],
  knownIds: Iterable<T>,
): RefCodec<T> {
  const byIdString = new Map<string, T>();
  for (const id of knownIds) byIdString.set(id, id);

  const toCode = new Map<T, string>();
  const fromCode = new Map<string, T>();
  for (let index = 0; index < table.length; index++) {
    const id = byIdString.get(table[index]);
    if (!id) continue;
    const code = index.toString(36);
    toCode.set(id, code);
    fromCode.set(code, id);
  }

  return {
    encode: (id) => toCode.get(id) ?? id,
    decode: (token) => byIdString.get(token) ?? fromCode.get(token) ?? null,
  };
}

const itemCodec = makeRefCodec<ItemId>(
  itemCodeTable,
  items.map((i) => i.id),
);
const recipeCodec = makeRefCodec<RecipeId>(
  recipeCodeTable,
  recipes.map((r) => r.id),
);
const facilityCodec = makeRefCodec<FacilityId>(
  facilityCodeTable,
  facilities.map((f) => f.id),
);
const structureCodec = makeRefCodec<RegionStructureId>(
  structureCodeTable,
  [...regionStructures.values()].flatMap((list) => list.map((s) => s.id)),
);
const techCodec = makeRefCodec<AicTechId>(
  techCodeTable,
  aicNodes.map((n) => n.id),
);

export const encodeItemRef = itemCodec.encode;
export const decodeItemRef = itemCodec.decode;

export const encodeRecipeRef = recipeCodec.encode;
export const decodeRecipeRef = recipeCodec.decode;

export const encodeFacilityRef = facilityCodec.encode;
export const decodeFacilityRef = facilityCodec.decode;

export const encodeStructureRef = structureCodec.encode;
export const decodeStructureRef = structureCodec.decode;

export const encodeTechRef = techCodec.encode;
export const decodeTechRef = techCodec.decode;
