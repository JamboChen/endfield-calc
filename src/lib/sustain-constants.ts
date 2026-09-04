/**
 * Shared gas-sustain constants (1.4). Lives OUTSIDE `calculator.ts` so
 * UI modules (`useProductionPlan`, the plan-options section) can import
 * it without statically pulling the solver into the main bundle — the
 * calculator is dynamic-imported by `calc-client` (worker fallback) and
 * must stay code-split.
 */

/**
 * Default machines-per-vaporizer coverage ratio. One Gas Dispersing
 * Unit's aura is 13×13 (rangeExtend 5 around a 3×3 footprint) and
 * buildings must sit FULLY inside — best packing fits 4 machines of the
 * 5×5/6×4 classes that carry env-gated recipes. User-tunable via the
 * plan option (URL key `mpv`).
 */
export const DEFAULT_MACHINES_PER_VAPORIZER = 4;

/** Inclusive bounds the coverage ratio is clamped to. */
const MIN_MACHINES_PER_VAPORIZER = 1;
const MAX_MACHINES_PER_VAPORIZER = 16;

/**
 * Coerce an untrusted coverage ratio (URL param, localStorage, a
 * hand-edited plan file) to a legal whole-machine count, falling back to
 * the default rather than propagating something the solver can't use.
 */
export function sanitizeMachinesPerVaporizer(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MACHINES_PER_VAPORIZER;
  const int = Math.round(value);
  return int >= MIN_MACHINES_PER_VAPORIZER && int <= MAX_MACHINES_PER_VAPORIZER
    ? int
    : DEFAULT_MACHINES_PER_VAPORIZER;
}
