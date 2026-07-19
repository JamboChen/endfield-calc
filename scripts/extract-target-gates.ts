/**
 * extract-target-gates — derives `src/data/target-gates.ts`: for every
 * item that is producible only after some AIC-research / region-activation
 * unlock, the (valid) set of regions to activate + techs to research,
 * grouped by region and ordered earliest-first.
 *
 * STANDALONE by design (like `extract:item-colors`, and NOT part of
 * `extract:all`): it reads only COMMITTED `src/data` (recipes, facilities,
 * items, region raws, AIC plans) via `computeTargetGates` — NO game-data
 * dir. It is intentionally excluded from the `extract:all` orchestrator:
 * that pipeline regenerates the `src/data` files in-process, but this
 * script imports them at module-load, so chaining it there would read the
 * pre-regeneration snapshot. Instead, re-run it whenever the data files it
 * derives from change:
 *   `bun run extract:target-gates`
 *
 * The `src/tests/lib/target-gates.test.ts` guard recomputes via the same
 * `computeTargetGates` and asserts the committed file matches, so CI
 * (which can't run the game-data extractors) still catches drift when the
 * upstream data files change without a regenerate.
 */
import * as path from "node:path";

import { toLF, writeStable } from "./lib/io";
import { REPO_ROOT } from "./lib/paths";
import { computeTargetGates } from "@/lib/target-gate-helpers";
import type { TargetGate } from "@/types/target-gates";
import type { ItemId } from "@/types/constants";

const SCRIPT_TAG = "extract-target-gates";
const OUT_PATH = path.join(REPO_ROOT, "src", "data", "target-gates.ts");

/** `domain_2` → `DomainId.DOMAIN_2` (matches `codegen.idToEnumKey`). */
function domainAccessor(domainId: string): string {
  return `DomainId.${domainId.toUpperCase()}`;
}

function emitPlanRegion(
  region: TargetGate["factories"][number]["planRegions"][number],
): string {
  const techs = `[${region.techIds
    .map((t) => `"${t}" as AicTechId`)
    .join(", ")}]`;
  return `        { domainId: ${domainAccessor(region.domainId)}, techIds: ${techs} },`;
}

function emit(gates: ReadonlyMap<ItemId, TargetGate>): string {
  const entries = [...gates.entries()].sort(([a], [b]) => a.localeCompare(b));

  const lines: string[] = [];
  lines.push(
    "// AUTO-GENERATED — do not hand-edit. Run `bun run extract:target-gates` to regenerate.",
    "//",
    "// Derived from committed src/data (recipes, facilities, items, region raws,",
    "// AIC plans) by `computeTargetGates` — no game-data dir required. See",
    "// scripts/extract-target-gates.ts and src/lib/target-gate-helpers.ts.",
    "//",
    "// item → per factory region (currentDomain), the AIC techs to research",
    "// before it becomes producible there, grouped by plan region and ordered",
    "// earliest-first (by sortId).",
    "",
    'import type { ItemId } from "@/types/constants";',
    'import { DomainId } from "@/types/constants";',
    'import type { AicTechId } from "@/types/aic";',
    'import type { TargetGate } from "@/types/target-gates";',
    "",
    "export const targetGates: ReadonlyMap<ItemId, TargetGate> = new Map([",
  );

  for (const [itemId, gate] of entries) {
    lines.push(`  ["${itemId}" as ItemId, {`);
    lines.push("    factories: [");
    for (const factory of gate.factories) {
      lines.push(
        `      { factoryDomainId: ${domainAccessor(factory.factoryDomainId)}, planRegions: [`,
      );
      for (const region of factory.planRegions) lines.push(emitPlanRegion(region));
      lines.push("      ] },");
    }
    lines.push("    ],");
    lines.push("  }],");
  }

  lines.push("]);", "");
  return toLF(lines.join("\n"));
}

export function run(): void {
  const { gates, warnings } = computeTargetGates();

  for (const w of warnings) console.warn(`[${SCRIPT_TAG}] ${w}`);

  writeStable(OUT_PATH, emit(gates));
  console.log(
    `[${SCRIPT_TAG}] Wrote ${gates.size} target gate(s) → ${path.relative(REPO_ROOT, OUT_PATH)}`,
  );
}

if (import.meta.main) run();
