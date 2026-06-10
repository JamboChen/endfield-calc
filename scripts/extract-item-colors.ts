/**
 * extract-item-colors — derives a representative edge colour per item
 * from its icon and emits `src/data/item-colors.ts`.
 *
 * STANDALONE by design: unlike the `extract:all` family (which reads the
 * `ENDFIELD_DATA_DIR` game-data dump), this script reads the icons that
 * are MANUALLY curated into `public/images/items/<item_id>.png`. The
 * icon pipeline can't be automated, so this script is not part of the
 * `extract-all` orchestrator — re-run it whenever icons are added or
 * replaced: `pnpm run extract:item-colors`.
 *
 * Per icon:
 *   1. Decode the RGBA PNG (pngjs).
 *   2. Convert each pixel sRGB → OKLCH; weight it by `alpha × chroma`,
 *      which suppresses the transparent background, white highlights,
 *      and gray outlines that would otherwise wash out the hue.
 *   3. Find the DOMINANT hue: 36-bin hue histogram → peak bin (±1
 *      neighbour) → weighted circular mean. A plain average would turn
 *      a red+blue icon purple; the histogram keeps the majority colour.
 *   4. Chroma factor: mean OKLCH chroma of the winning pixels relative
 *      to CHROMA_REF, clamped — visually gray items (ores, stone) get
 *      gray-ish edges instead of a fake saturated hue. Icons with no
 *      saturated pixels at all get the GRAY_* fallbacks.
 *   5. Distinctness pass: an edge colour's identity is the (hue, chroma
 *      factor) PAIR. 178 items cannot all be ≥8° apart on a 360° hue
 *      wheel (and the game's palette clusters in orange/teal/blue
 *      bands), so when two items land within 2° of hue AND 0.08 of
 *      chroma factor, the later one (id order — deterministic) steps
 *      its chroma factor ±0.1 until free, falling back to ±2° hue
 *      nudges only if the chroma axis is exhausted. Same-family items
 *      (e.g. the Xiranite line, one shared teal) thus stay SIMILAR in
 *      hue but render at visibly different saturations — never
 *      identical.
 *
 * Only ids present in the `ItemId` enum are emitted; orphan icons (file
 * without an enum entry) and icon-less items are warned about, mirroring
 * the orphan-guard culture of the other extract scripts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";

import { toCRLF, writeStable } from "./lib/io";
import { parseEnumBlock } from "./lib/enum-parse";
import { REPO_ROOT } from "./lib/paths";

const SCRIPT_TAG = "extract-item-colors";

const ICONS_DIR = path.join(REPO_ROOT, "public", "images", "items");
const CONSTANTS_PATH = path.join(REPO_ROOT, "src", "types", "constants.ts");
const OUT_PATH = path.join(REPO_ROOT, "src", "data", "item-colors.ts");

/** Pixels more transparent than this are background; skip them. */
const ALPHA_FLOOR = 0.25;
/** Hue histogram resolution (36 bins × 10°). */
const HUE_BINS = 36;
/**
 * OKLCH chroma of a "fully vivid" icon region — winning-pixel mean
 * chroma is expressed relative to this. Saturated sRGB primaries sit
 * around C ≈ 0.25–0.31; icon art (shaded, outlined) averages lower.
 */
const CHROMA_REF = 0.14;
/** Clamp range for the emitted chroma factor. */
const CHROMA_FACTOR_MIN = 0.25;
const CHROMA_FACTOR_MAX = 1.25;
/**
 * Icons whose total `alpha × chroma` weight stays below this are
 * effectively grayscale — emit a muted factor and an alpha-weighted hue.
 */
const GRAY_WEIGHT_EPSILON = 1;
const GRAY_CHROMA_FACTOR = CHROMA_FACTOR_MIN;
/**
 * Two colours are "the same" when BOTH axes are inside these thresholds;
 * the distinctness pass separates such pairs.
 */
const HUE_MIN_SEP = 2;
const CHROMA_MIN_SEP = 0.08;
/** Step sizes used by the distinctness pass. */
const CHROMA_STEP = 0.1;
const HUE_STEP = 2;

interface OklchPixel {
  /** Chroma (OKLCH C). */
  c: number;
  /** Hue in degrees [0, 360). */
  h: number;
  /** Pixel weight: alpha × chroma. */
  w: number;
  /** Alpha in [0, 1] (for the grayscale-icon fallback). */
  a: number;
}

function srgbChannelToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB → OKLab (Björn Ottosson's reference matrices) → chroma + hue. */
function srgbToOklch(r8: number, g8: number, b8: number): { c: number; h: number } {
  const r = srgbChannelToLinear(r8);
  const g = srgbChannelToLinear(g8);
  const b = srgbChannelToLinear(b8);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  const A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

  const c = Math.hypot(A, B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { c, h };
}

/** Circular hue distance in degrees, in [0, 180]. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/**
 * Enforce pairwise distinctness on the (hue, chroma-factor) plane.
 * Items are processed in id order (deterministic); an item colliding
 * with an already-accepted colour (Δhue < HUE_MIN_SEP AND Δfactor <
 * CHROMA_MIN_SEP) tries chroma-factor steps (±0.1, ±0.2, …) first —
 * saturation variation preserves the colour family — then ±hue nudges
 * combined with the chroma sweep as a fallback.
 */
function resolveDistinctColors(
  rawColors: Map<string, IconColor>,
): Map<string, IconColor> {
  const clampC = (c: number): number =>
    Math.min(CHROMA_FACTOR_MAX, Math.max(CHROMA_FACTOR_MIN, c));
  const round2 = (c: number): number => Math.round(c * 100) / 100;

  // Candidate offsets, nearest-first: chroma sweep within each hue ring.
  const chromaDeltas = [0];
  for (let i = 1; i <= 10; i++) chromaDeltas.push(i * CHROMA_STEP, -i * CHROMA_STEP);
  const hueDeltas = [0];
  for (let i = 1; i <= 8; i++) hueDeltas.push(i * HUE_STEP, -i * HUE_STEP);

  const accepted: { h: number; c: number }[] = [];
  const out = new Map<string, IconColor>();

  for (const id of [...rawColors.keys()].sort()) {
    const raw = rawColors.get(id)!;
    const baseH = ((Math.round(raw.h) % 360) + 360) % 360;
    const baseC = round2(clampC(raw.c));

    let chosen: { h: number; c: number } | undefined;
    outer: for (const dh of hueDeltas) {
      const h = ((baseH + dh) % 360 + 360) % 360;
      for (const dc of chromaDeltas) {
        const c = round2(clampC(baseC + dc));
        // Clamping can collapse distinct deltas onto the same value;
        // skip candidates that didn't actually move.
        if (dc !== 0 && c === baseC && dh === 0) continue;
        const collides = accepted.some(
          (p) =>
            hueDistance(p.h, h) < HUE_MIN_SEP &&
            Math.abs(p.c - c) < CHROMA_MIN_SEP,
        );
        if (!collides) {
          chosen = { h, c };
          break outer;
        }
      }
    }
    // Pathological fallback (search space exhausted): keep the raw
    // colour — better a rare duplicate than dropping the item.
    if (!chosen) chosen = { h: baseH, c: baseC };

    accepted.push(chosen);
    out.set(id, { h: chosen.h, c: chosen.c, isGray: raw.isGray });
  }
  return out;
}

/** Weighted circular mean of hues (degrees), normalized to [0, 360). */
function circularMean(
  pixels: OklchPixel[],
  weightOf: (p: OklchPixel) => number,
): number {
  let x = 0;
  let y = 0;
  for (const p of pixels) {
    const w = weightOf(p);
    const rad = (p.h * Math.PI) / 180;
    x += w * Math.cos(rad);
    y += w * Math.sin(rad);
  }
  let h = (Math.atan2(y, x) * 180) / Math.PI;
  if (h < 0) h += 360;
  return h;
}

interface IconColor {
  h: number;
  c: number;
  /** True when the icon had no saturated pixels (gray fallback used). */
  isGray: boolean;
}

function extractIconColor(pngPath: string): IconColor {
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const { width, height, data } = png;

  const pixels: OklchPixel[] = [];
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const a = data[o + 3] / 255;
    if (a < ALPHA_FLOOR) continue;
    const { c, h } = srgbToOklch(data[o], data[o + 1], data[o + 2]);
    pixels.push({ c, h, w: a * c, a });
  }

  const totalWeight = pixels.reduce((sum, p) => sum + p.w, 0);
  if (pixels.length === 0 || totalWeight < GRAY_WEIGHT_EPSILON) {
    // Effectively grayscale icon: muted edge; hue from whatever faint
    // tint exists (alpha-weighted), purely so the value is stable.
    return {
      h: pixels.length > 0 ? circularMean(pixels, (p) => p.a) : 0,
      c: GRAY_CHROMA_FACTOR,
      isGray: true,
    };
  }

  // Hue histogram by weight; dominant bin ± 1 neighbour wins.
  const bins = new Array<number>(HUE_BINS).fill(0);
  for (const p of pixels) {
    bins[Math.floor(p.h / (360 / HUE_BINS)) % HUE_BINS] += p.w;
  }
  let peak = 0;
  for (let i = 1; i < HUE_BINS; i++) {
    if (bins[i] > bins[peak]) peak = i;
  }
  const inWinningBins = (p: OklchPixel): boolean => {
    const bin = Math.floor(p.h / (360 / HUE_BINS)) % HUE_BINS;
    return (
      bin === peak ||
      bin === (peak + 1) % HUE_BINS ||
      bin === (peak + HUE_BINS - 1) % HUE_BINS
    );
  };
  const winners = pixels.filter(inWinningBins);

  const hue = circularMean(winners, (p) => p.w);
  const winnersWeight = winners.reduce((sum, p) => sum + p.w, 0);
  const meanChroma =
    winners.reduce((sum, p) => sum + p.c * p.w, 0) / winnersWeight;
  const factor = Math.min(
    CHROMA_FACTOR_MAX,
    Math.max(CHROMA_FACTOR_MIN, meanChroma / CHROMA_REF),
  );

  return { h: hue, c: factor, isGray: false };
}

// Not exported: unlike the extract-all family, nothing orchestrates this
// script — it runs standalone via `pnpm run extract:item-colors`.
function run(): void {
  const itemEnum = parseEnumBlock(CONSTANTS_PATH, "ItemId");
  const enumIds = new Set(itemEnum.entries.map((e) => e.value));

  const iconFiles = fs
    .readdirSync(ICONS_DIR)
    .filter((f) => f.endsWith(".png"))
    .sort();

  // Pass 1: dominant colour per icon.
  const rawColors = new Map<string, IconColor>();
  const orphanIcons: string[] = [];
  for (const file of iconFiles) {
    const id = file.replace(/\.png$/, "");
    if (!enumIds.has(id)) {
      orphanIcons.push(file);
      continue;
    }
    rawColors.set(id, extractIconColor(path.join(ICONS_DIR, file)));
  }

  // Pass 2: enforce (hue, chroma) pairwise distinctness.
  const colors = resolveDistinctColors(rawColors);

  const missingIcons = itemEnum.entries
    .map((e) => e.value)
    .filter((id) => !colors.has(id));

  // Emit, sorted by id for stable diffs.
  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * AUTO-GENERATED by `pnpm run extract:item-colors` — DO NOT EDIT BY HAND.");
  lines.push(" *");
  lines.push(" * Representative edge colour per item, derived from the item's icon");
  lines.push(" * (`public/images/items/<id>.png`): dominant OKLCH hue (integer degrees)");
  lines.push(" * plus a chroma factor (relative to the `--flow-edge-c` theme variable;");
  lines.push(" * gray icons get muted edges). No two entries share BOTH a hue (within");
  lines.push(" * 2°) and a chroma factor (within 0.08) — same-family items stay similar");
  lines.push(" * in hue but render at visibly different saturations.");
  lines.push(" *");
  lines.push(" * Consumed by `getItemEdgeColor` (src/components/flow/flow-utils.ts);");
  lines.push(" * items absent from this map fall back to a hash-derived hue there.");
  lines.push(" *");
  lines.push(" * Icons are manually curated, so this generator is NOT part of");
  lines.push(" * `extract:all` — re-run it whenever icons change.");
  lines.push(" */");
  lines.push("export const itemIconColors: Readonly<");
  lines.push("  Record<string, { h: number; c: number }>");
  lines.push("> = {");
  for (const id of [...colors.keys()].sort()) {
    const { h, c } = colors.get(id)!;
    lines.push(`  ${id}: { h: ${h}, c: ${c} },`);
  }
  lines.push("};");
  lines.push("");

  writeStable(OUT_PATH, toCRLF(lines.join("\n")));

  // Summary
  const grays = [...colors.values()].filter((c) => c.isGray).length;
  let adjusted = 0;
  for (const [id, color] of colors) {
    const raw = rawColors.get(id)!;
    if (
      color.h !== ((Math.round(raw.h) % 360) + 360) % 360 ||
      Math.abs(color.c - raw.c) > 0.049
    ) {
      adjusted++;
    }
  }
  const factors = [...colors.values()].map((c) => c.c);
  const meanFactor = factors.reduce((a, b) => a + b, 0) / factors.length;
  console.log(`[${SCRIPT_TAG}] Wrote ${path.relative(REPO_ROOT, OUT_PATH)}`);
  console.log(`  items coloured:            ${colors.size}`);
  console.log(`    grayscale fallbacks:     ${grays}`);
  console.log(`    distinctness-adjusted:   ${adjusted}`);
  console.log(
    `    chroma factor min/mean/max: ${Math.min(...factors).toFixed(2)} / ${meanFactor.toFixed(2)} / ${Math.max(...factors).toFixed(2)}`,
  );
  if (orphanIcons.length > 0) {
    console.log(
      `  WARNING: ${orphanIcons.length} icon(s) without an ItemId enum entry (skipped):`,
    );
    for (const f of orphanIcons) console.log(`    - ${f}`);
  }
  if (missingIcons.length > 0) {
    console.log(
      `  WARNING: ${missingIcons.length} ItemId(s) without an icon (will use hash-fallback colour):`,
    );
    for (const id of missingIcons) console.log(`    - ${id}`);
  }
}

if (import.meta.main) run();
