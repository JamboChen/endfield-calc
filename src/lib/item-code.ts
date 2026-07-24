/**
 * Short, stable item codes for shareable URLs.
 *
 * Item ids (`item_copper_enr2_cmpt`, ~18 chars) dominate the length of
 * both the plan params (`t=`/`r=`/`m=`) and the settings blob (`s=`'s raw
 * limits). This maps each to a 1–2 char base36 code from the append-only
 * registry `src/data/item-codes.ts` (code = the entry's array index in
 * base36). The registry is stable forever — see `gen-item-codes.ts` — so
 * codes in already-shared URLs never change meaning.
 *
 * Decoding is backward-compatible: a token is resolved as a full id
 * (links shared before codes existed) OR a code, so old plan URLs keep
 * working.
 */

import { items } from "@/data";
import { itemCodeTable } from "@/data/item-codes";
import type { ItemId } from "@/types";

// Real item-id strings → their branded ItemId — the runtime source of
// truth for what actually exists (tombstoned / stale registry entries
// resolve to nothing here and are skipped below).
const byIdString = new Map<string, ItemId>(items.map((i) => [i.id, i.id]));

const itemToCode = new Map<ItemId, string>();
const codeToItem = new Map<string, ItemId>();
for (let index = 0; index < itemCodeTable.length; index++) {
  const id = byIdString.get(itemCodeTable[index]);
  if (!id) continue;
  const code = index.toString(36);
  itemToCode.set(id, code);
  codeToItem.set(code, id);
}

/**
 * Item id → its short URL code. Falls back to the full id if the item
 * somehow has no code (the `item-code.test.ts` completeness guard
 * prevents this in practice); the fallback is still decodable.
 */
export function encodeItemRef(id: ItemId): string {
  return itemToCode.get(id) ?? id;
}

/**
 * Resolve a URL item token to an ItemId. Accepts BOTH a full id (legacy
 * links + the fallback above) and a short code (new links). `null` when
 * neither is known — the caller drops the reference.
 */
export function decodeItemRef(token: string): ItemId | null {
  return byIdString.get(token) ?? codeToItem.get(token) ?? null;
}
