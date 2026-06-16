import type { ItemId } from "./constants";
import type { DomainId } from "./domain";

/**
 * Metastorage Transfer — inter-region lossless item supply.
 *
 * A source region that reaches its `unlockLosslessLevel` (Regional
 * Development Level) can ship **one item type at a time** to one other
 * region, delivered once per `cycleSeconds`, WITHOUT debiting the source
 * depot. Throughput is bounded by the source's Total Transfer Value
 * (TTV) budget per delivery cycle: each item carries a per-unit TTV
 * cost, so the max rate for an item is
 * `ttvCapPerCycle / cost / (cycleSeconds / 60)` items/min.
 *
 * Capability + per-item costs are AUTO-GENERATED into
 * `src/data/metastorage.ts` by `scripts/extract-metastorage.ts` from
 * `FactoryDomainItemTransmissionTable` / `FactoryConst` /
 * `FactoryItemTable`.
 */

/**
 * Per-source-region Metastorage capability, keyed by source `DomainId`
 * in `metastorageSources`.
 */
type MetastorageSourceInfo = {
  /**
   * Total Transfer Value budget per delivery cycle. Taken at the
   * fully-developed level (max capacity across levels ≥
   * `unlockLosslessLevel`) — the calculator applies no level gating.
   */
  readonly ttvCapPerCycle: number;
  /** Real-time seconds between deliveries (`domainTransportIntervalTime`). */
  readonly cycleSeconds: number;
  /** Regional Development Level that unlocks Metastorage (lossless) Transfer. */
  readonly unlockLosslessLevel: number;
  /** Max simultaneous outbound routes from this source (1 in current data). */
  readonly routeNum: number;
};

/**
 * User-facing route mode for a **source** region, owned by
 * `useDomainSettings.metastorage`:
 *
 *   - `"auto"` (default) — the source exports to whichever region is
 *     currently being planned (any region except itself).
 *   - `"disabled"` — the source's Metastorage Transfer is off; no plan
 *     imports from it.
 *   - a `DomainId` — locked to that destination; only plans for that
 *     region may import from this source.
 */
type MetastorageRouteMode = "auto" | "disabled" | DomainId;

/**
 * Calc-layer config for one resolved import route feeding the
 * currently-planned region. Built by the App bridge from
 * `metastorageSources` + `metastorageExports` + the user's route modes;
 * consumed by `calculateProductionPlan`, which auto-selects the single
 * transferred item from `itemCosts`.
 */
type MetastorageRouteConfig = {
  /** Exporting region. */
  readonly sourceDomain: DomainId;
  /** TTV budget per minute (`ttvCapPerCycle / (cycleSeconds / 60)`). */
  readonly ttvBudgetPerMinute: number;
  /** Real-time seconds per delivery cycle (for per-delivery display). */
  readonly cycleSeconds: number;
  /** Eligible item → per-unit TTV cost, for items native to the source. */
  readonly itemCosts: ReadonlyMap<ItemId, number>;
};

export type {
  MetastorageRouteConfig,
  MetastorageRouteMode,
  MetastorageSourceInfo,
};
