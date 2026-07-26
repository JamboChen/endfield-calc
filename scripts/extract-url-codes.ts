/**
 * extract-url-codes — maintains `src/data/id-codes.ts`, the stable,
 * APPEND-ONLY id→code registries that keep shareable plan URLs short
 * (items, recipes, facilities, region structures, AIC techs).
 *
 * STANDALONE + self-contained: it parses committed files only (the enums
 * in `src/types/constants.ts`, the AIC node table, and the existing
 * registry), so unlike the game-data extractors it needs no data dir and
 * anyone can run it — `pnpm run extract:url-codes`. Run it after
 * `extract:all`.
 *
 * # The one rule
 *
 * A code is the entry's `index.toString(36)`, so an index must never
 * move or be reused — shared URLs reference them. This script therefore
 * ONLY ever appends. It never reorders, and it never deletes.
 *
 * # Why removed ids stay
 *
 * They are kept, named, forever. Nothing here decides liveness: the
 * codec (`src/lib/url-codes.ts`) resolves a code only when the id exists
 * in the live game data, so a departed id simply stops resolving. That
 * has three consequences worth knowing:
 *
 *   - a removal needs no regeneration at all — the file is purely
 *     append-only, which is the simplest contract available and cannot
 *     go stale;
 *   - an id removed by one patch and restored by a later one KEEPS its
 *     original code, so links shared in between start working again
 *     (blanking the slot used to append a second, different code for
 *     the same id and silently break those links);
 *   - the registry is a superset of the enums by design. Do not read
 *     "present here" as "exists" — that is the codec's job.
 *
 * The completeness guard in `src/tests/lib/url-codes.test.ts` fails if a
 * new id has no code (i.e. this wasn't re-run), and the pinned-code test
 * there fails if any existing code moves.
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
const OUT_PATH = path.join(REPO_ROOT, "src", "data", "id-codes.ts");

interface Registry {
  /** The id type this registry mirrors (doc header + error messages). */
  readonly typeName: string;
  /** Exported table name in the generated module. */
  readonly tableName: string;
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
    label: "items",
    usage: "plan targets, recipe pins, manual raws and raw-limit overrides",
    readIds: fromConstantsEnum("ItemId"),
  },
  {
    typeName: "RecipeId",
    tableName: "recipeCodeTable",
    label: "recipes",
    usage: "recipe pins",
    readIds: fromConstantsEnum("RecipeId"),
  },
  {
    typeName: "FacilityId",
    tableName: "facilityCodeTable",
    label: "facilities",
    usage: "AIC facility-cap overrides",
    readIds: fromConstantsEnum("FacilityId"),
  },
  {
    typeName: "RegionStructureId",
    tableName: "structureCodeTable",
    label: "structures",
    usage: "disabled map structures",
    readIds: fromConstantsEnum("RegionStructureId"),
  },
  {
    typeName: "AicTechId",
    tableName: "techCodeTable",
    label: "AIC techs",
    usage: "the unresearched-tech list, the largest field in the blob",
    readIds: fromAicNodes(),
  },
];

/**
 * The previously-emitted table for one registry (or [] on first run).
 *
 * Anchored on the full `= [ … \n];` declaration: a looser pattern can
 * match the `[]` of the `readonly string[]` type annotation instead of
 * the array literal and silently read back an EMPTY registry, which
 * would renumber every code.
 */
function existingTable(source: string, tableName: string): string[] {
  const arr = source.match(
    new RegExp(`export const ${tableName}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`),
  );
  if (!arr) {
    throw new Error(
      `extract-url-codes: could not read the existing ${tableName} from ` +
        `${path.relative(REPO_ROOT, OUT_PATH)} — refusing to run, since ` +
        `regenerating from scratch would renumber already-shared codes.`,
    );
  }
  return [...arr[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

interface Updated {
  readonly registry: Registry;
  readonly table: readonly string[];
  readonly appended: number;
  readonly liveCount: number;
}

/** Append any ids missing from this registry's table. Never removes. */
function updateRegistry(registry: Registry, previous: string): Updated {
  const ids = registry.readIds();
  const table = previous ? existingTable(previous, registry.tableName) : [];

  const known = new Set(table);
  let appended = 0;
  for (const id of ids) {
    if (!known.has(id)) {
      table.push(id);
      known.add(id);
      appended++;
    }
  }

  const live = new Set(ids);
  return {
    registry,
    table,
    appended,
    liveCount: table.filter((id) => live.has(id)).length,
  };
}

function emit(updates: readonly Updated[]): string {
  const lines: string[] = [
    "/**",
    " * AUTO-GENERATED by `pnpm run extract:url-codes` — DO NOT EDIT BY HAND.",
    " *",
    " * Stable, APPEND-ONLY id→code registries for shareable plan URLs. A",
    " * code is the entry's `index.toString(36)`, so an index must never move",
    " * or be reused: shared URLs reference them.",
    " *",
    " * These lists are a SUPERSET of the `constants.ts` enums and stay that",
    " * way on purpose. An id removed from the game keeps its slot, named,",
    " * forever — `src/lib/url-codes.ts` resolves a code only for ids present",
    " * in the live game data, so a departed id stops resolving on its own and",
    " * a restored one gets its original code back. Do NOT read \"listed here\"",
    " * as \"exists\", and never derive codes from the enums: those are sorted",
    " * and shed removals, which would renumber everything.",
    " */",
    "",
  ];
  for (const { registry, table } of updates) {
    lines.push(
      `/** ${registry.typeName} — ${registry.usage}. */`,
      `export const ${registry.tableName}: readonly string[] = [`,
      ...table.map((id) => `  ${JSON.stringify(id)},`),
      "];",
      "",
    );
  }
  return lines.join("\n");
}

function run(): void {
  const previous = fs.existsSync(OUT_PATH)
    ? fs.readFileSync(OUT_PATH, "utf8")
    : "";
  const updates = REGISTRIES.map((r) => updateRegistry(r, previous));
  fs.writeFileSync(OUT_PATH, emit(updates));

  console.log(`[extract-url-codes] wrote ${path.relative(REPO_ROOT, OUT_PATH)}`);
  for (const { registry, table, appended, liveCount } of updates) {
    console.log(
      `  ${registry.label.padEnd(12)} ${String(liveCount).padStart(3)} live, ` +
        `${appended} appended, ${table.length - liveCount} retired, ` +
        `next code "${table.length.toString(36)}"`,
    );
  }
}

run();
