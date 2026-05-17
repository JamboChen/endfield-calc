/**
 * Shared numerical thresholds for the production-flow pipeline.
 *
 * These constants form a CONTRACT between the Phase 3 packer
 * (`multi-formula-packing.ts`) and the bin-fused mappers
 * (`bin-fused-mapper.ts`). Diverging values between them would
 * re-introduce the "isolated-bin" class of bugs where the packer
 * emits a bin whose rates fall in a window the mapper's edge
 * allocator can't service.
 *
 * If you change a value here, audit every site that compares against
 * a per-minute rate or per-slot demand and verify the new value is
 * consistent with both producer-side filtering (packer) and
 * consumer-side allocation (mapper).
 */

/**
 * Minimum item rate (items/min) below which a flow is considered
 * sub-visible — too small to allocate an edge to/from in the bin-
 * fused mapper, and too small to be meaningful in the production
 * graph.
 *
 * Used by:
 * - **`multi-formula-packing.ts`**: emission filter for variants
 *   whose max recipe rate falls below this threshold. Prevents the
 *   LP's floating-point residue from emitting bins that the mapper
 *   would orphan.
 * - **`bin-fused-mapper.ts`**: greedy edge allocator's cutoff for
 *   producer/consumer rates. Edges below this aren't allocated.
 * - Various other rate-based skip checks in the mapper (target
 *   rates, disposal rates, per-building rates).
 *
 * Value: `0.001` items/min — chosen to match the legacy
 * hardcoded threshold across multiple mapper sites. Roughly
 * "1 item per ~17 hours" which is far below any practically
 * meaningful production cadence and below the LP solver's
 * floating-point precision floor.
 */
export const MIN_VISIBLE_RATE_PER_MIN = 0.001;
