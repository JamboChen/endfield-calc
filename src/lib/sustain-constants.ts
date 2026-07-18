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
