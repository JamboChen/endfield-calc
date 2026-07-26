/**
 * extract-url-codes — maintains the stable, APPEND-ONLY id→code registries
 * that keep shareable plan URLs short:
 *
 *   src/data/item-codes.ts       ItemId            (targets, raw limits, pins)
 *   src/data/recipe-codes.ts     RecipeId          (recipe pins)
 *   src/data/facility-codes.ts   FacilityId        (AIC cap overrides)
 *   src/data/structure-codes.ts  RegionStructureId (disabled structures)
 *   src/data/tech-codes.ts       AicTechId         (unresearched AIC techs)
 *
 * STANDALONE + self-contained: it parses committed files only (the enums
 * in `src/types/constants.ts`, the AIC node table, and the existing
 * registries), so unlike the game-data extractors it needs no data dir
 * and anyone can run it — `pnpm run extract:url-codes`. Run it after
 * `extract:all`.
 *
 * A code is the entry's `index.toString(36)`. Codes must NEVER change or
 * be reused (shared URLs reference them), so this only:
 *   - keeps every existing entry at its index (codes stay stable),
 *   - tombstones ("") ids that left the enum (index retired, not reused),
 *   - appends new ids at the end.
 *
 * The completeness guard in `src/tests/lib/url-codes.test.ts` fails if a
 * new id has no code (i.e. this wasn't re-run) — that's the "fail if we
 * forget" backstop.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CONSTANTS_PATH = path.join(REPO_ROOT, "src", "types", "constants.ts");
const AIC_PLANS_PATH = path.join(REPO_ROOT, "src", "data", "aic-plans.ts");
const DATA_DIR = path.join(REPO_ROOT, "src", "data");

interface Registry {
  /** The id type this registry mirrors (doc header + error messages). */
  readonly typeName: string;
  /** Exported table name in the generated module. */
  readonly tableName: string;
  /** Generated file, relative to `src/data/`. */
  readonly fileName: string;
  /** Plural noun for the doc header + console summary. */
  readonly label: string;
  /** What the codes shorten, for the doc header. */
  readonly usage: string;
  /** Every live id, in source order. */
  readonly readIds: () => string[];
}

/**
 * Ids from a closed-enum literal-string union in `constants.ts` — the
 * shape every game-data id type uses (`const X = { … } as const`).
 */
function fromConstantsEnum(typeName: string): () => string[] {
  return () => {
    const source = fs.readFileSync(CONSTANTS_PATH, "utf8");
    const block = source.match(
      new RegExp(`const ${typeName} = \\{([\\s\\S]*?)\\} as const;`),
    );
    if (!block) {
      throw new Error(
        `extract-url-codes: ${typeName} enum not found in constants.ts`,
      );
    }
    return [...block[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  };
}

/**
 * `AicTechId`s from the AIC node table. Unlike the other id types this
 * one is a brand (`src/types/aic.ts`), not a `constants.ts` enum, so the
 * ids only exist as the `id:` field of each generated node entry.
 */
function fromAicNodes(): () => string[] {
  return () => {
    const source = fs.readFileSync(AIC_PLANS_PATH, "utf8");
    const ids = [...source.matchAll(/^\s+id: "(tech_[a-z0-9_]+)"/gm)].map(
      (m) => m[1],
    );
    if (ids.length === 0) {
      throw new Error("extract-url-codes: no AicTechIds found in aic-plans.ts");
    }
    return ids;
  };
}

const REGISTRIES: readonly Registry[] = [
  {
    typeName: "ItemId",
    tableName: "itemCodeTable",
    fileName: "item-codes.ts",
    label: "items",
    usage: "plan targets, recipe pins, manual raws and raw-limit overrides",
    readIds: fromConstantsEnum("ItemId"),
  },
  {
    typeName: "RecipeId",
    tableName: "recipeCodeTable",
    fileName: "recipe-codes.ts",
    label: "recipes",
    usage: "recipe pins",
    readIds: fromConstantsEnum("RecipeId"),
  },
  {
    typeName: "FacilityId",
    tableName: "facilityCodeTable",
    fileName: "facility-codes.ts",
    label: "facilities",
    usage: "AIC facility-cap overrides",
    readIds: fromConstantsEnum("FacilityId"),
  },
  {
    typeName: "RegionStructureId",
    tableName: "structureCodeTable",
    fileName: "structure-codes.ts",
    label: "structures",
    usage: "disabled map structures",
    readIds: fromConstantsEnum("RegionStructureId"),
  },
  {
    typeName: "AicTechId",
    tableName: "techCodeTable",
    fileName: "tech-codes.ts",
    label: "AIC techs",
    usage: "the unresearched-tech list, the largest field in the blob",
    readIds: fromAicNodes(),
  },
];

/**
 * The previously-emitted table (or [] on first run), tombstones included.
 *
 * Anchored on the full `= [ … \n];` declaration: a looser pattern can
 * match the `[]` of the `readonly string[]` type annotation instead of
 * the array literal and silently read back an EMPTY registry, which
 * would renumber every code on the next run.
 */
function existingTable(outPath: string, tableName: string): string[] {
  if (!fs.existsSync(outPath)) return [];
  const src = fs.readFileSync(outPath, "utf8");
  const arr = src.match(
    new RegExp(`export const ${tableName}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`),
  );
  if (!arr) {
    throw new Error(
      `extract-url-codes: could not read the existing ${tableName} from ` +
        `${path.relative(REPO_ROOT, outPath)} — refusing to run, since ` +
        `regenerating from scratch would renumber already-shared codes.`,
    );
  }
  return [...arr[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

function updateRegistry(registry: Registry): void {
  const outPath = path.join(DATA_DIR, registry.fileName);
  const ids = registry.readIds();
  const live = new Set(ids);

  const table = existingTable(outPath, registry.tableName);
  // Retire ids that left the enum — keep the index (never reuse a code).
  for (let i = 0; i < table.length; i++) {
    if (table[i] !== "" && !live.has(table[i])) table[i] = "";
  }
  // Append genuinely-new ids (enum order) at the end.
  const known = new Set(table);
  let appended = 0;
  for (const id of ids) {
    if (!known.has(id)) {
      table.push(id);
      known.add(id);
      appended++;
    }
  }

  const lines = [
    "/**",
    " * AUTO-GENERATED by `pnpm run extract:url-codes` — DO NOT EDIT BY HAND.",
    " *",
    ` * Stable, APPEND-ONLY ${registry.typeName}→code registry for shareable`,
    ` * URLs (${registry.usage}).`,
    " *",
    " * A code is the entry's `index.toString(36)`; codes must never change or",
    " * be reused (shared plan URLs reference them). Re-running only appends",
    ' * new entries and tombstones ("") removed ones — it never reorders',
    " * existing entries.",
    " *",
    " * Re-run after `extract:all`; `url-codes.test.ts` fails if an id lacks a",
    " * code.",
    " */",
    `export const ${registry.tableName}: readonly string[] = [`,
    ...table.map((id) => `  ${JSON.stringify(id)},`),
    "];",
    "",
  ];
  fs.writeFileSync(outPath, lines.join("\n"));

  const liveCount = table.filter((id) => id !== "").length;
  console.log(
    `[extract-url-codes] wrote ${path.relative(REPO_ROOT, outPath)} — ` +
      `${liveCount} ${registry.label}, ${appended} appended, ` +
      `${table.length - liveCount} tombstones, next code "${table.length.toString(36)}"`,
  );
}

function run(): void {
  for (const registry of REGISTRIES) updateRegistry(registry);
}

run();
