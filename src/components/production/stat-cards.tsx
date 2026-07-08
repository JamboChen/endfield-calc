import { memo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowRight, Zap } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Facility, Item, PlanMetastorageImport } from "@/types";
import { getFacilityName, getItemName } from "@/lib/i18n-helpers";
import { cn, formatCount, getItemById } from "@/lib/utils";
import { rawMaterialSources } from "@/data";
import { domains } from "@/data/aic-plans";
import { tierClasses } from "@/lib/tier-styles";
import { FacilityIcon } from "@/components/FacilityIcon";

/** Cap-overflow info as threaded from `useProductionStats` /
 *  `useProductionPlan`. `undefined` → the row renders default chrome. */
type OverCapInfo = { used: number; cap: number } | undefined;

type FacilityStatCardProps = {
  facility: Facility;
  count: number;
  ceilMode: boolean;
  overCap: OverCapInfo;
  /**
   * Power subtotal for this facility type (`count × powerConsumption`).
   * Shown in the hover tooltip when > 0.
   */
  powerSubtotal?: number;
  /**
   * Fraction of built capacity the plan actually uses
   * (`rawLPCount ÷ ceiledCount`, 0..1). Only meaningful — and only
   * passed — in ceil mode. Curiosity-grade info: tooltip only.
   */
  utilization?: number;
};

/**
 * Single-line facility-requirement row: icon · name · ×count. The
 * secondary telemetry (power draw, utilization, over-cap numbers)
 * lives in a rich hover tooltip so the row itself stays scannable.
 * Over-cap rows render destructive chrome and stay focusable with an
 * explicit aria-label so keyboard/screen-reader users get the same
 * info without hover.
 */
export const FacilityStatCard = memo(function FacilityStatCard({
  facility,
  count,
  ceilMode,
  overCap,
  powerSubtotal,
  utilization,
}: FacilityStatCardProps) {
  const { t } = useTranslation("stats");
  const overCapLabel = overCap
    ? t("facilityCapExceeded", {
        // Physical placement count — always an integer (see
        // `BinAggregates.physicalPerFacility`), so no ceilMode
        // formatting: the number is the same in both display modes.
        used: String(overCap.used),
        cap: overCap.cap,
      })
    : undefined;
  const hasPower = powerSubtotal !== undefined && powerSubtotal > 0;
  const hasTooltip =
    hasPower || utilization !== undefined || overCap !== undefined;
  const row = (
    <div
      // Over-cap rows are made focusable + carry an explicit
      // aria-label so screen-reader and keyboard users get the same
      // info as the hover tooltip. Non-over-cap rows stay
      // un-focusable (the tooltip detail is hover-only convenience).
      tabIndex={overCap ? 0 : undefined}
      role={overCap ? "status" : undefined}
      aria-label={overCapLabel}
      className={cn(
        "flex items-center gap-1.5 rounded border px-2 py-1.5 min-w-0",
        overCap
          ? "border-destructive/70 bg-destructive/5"
          : "border-border/40 bg-card hover:bg-accent/40 transition-colors",
      )}
    >
      <FacilityIcon
        facility={facility}
        alt={getFacilityName(facility)}
        className="w-4 h-4 object-contain shrink-0"
      />
      <span className="text-xs truncate flex-1 min-w-0">
        {getFacilityName(facility)}
      </span>
      {overCap && (
        <AlertTriangle
          className="h-3 w-3 text-destructive shrink-0"
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          "text-xs font-semibold font-mono shrink-0 min-w-8 text-right",
          overCap && "text-destructive",
        )}
      >
        ×{formatCount(count, ceilMode)}
      </span>
      {/* The tooltip detail is hover-only; mirror it as visually-hidden
          text so screen readers get the same numbers when reading the
          row. */}
      {(hasPower || utilization !== undefined) && (
        <span className="sr-only">
          {hasPower &&
            `${t("powerDraw")}: ${formatCount(powerSubtotal, ceilMode)}. `}
          {utilization !== undefined &&
            `${t("utilization")}: ${Math.round(utilization * 100)}%.`}
        </span>
      )}
    </div>
  );
  if (!hasTooltip) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent variant="rich" sideOffset={4} className="p-2.5">
        <div className="space-y-1 text-xs">
          <div className="font-medium">
            {getFacilityName(facility)}
            <span className="font-mono text-muted-foreground ml-1.5">
              ×{formatCount(count, ceilMode)}
            </span>
          </div>
          {hasPower && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <Zap className="h-3 w-3" aria-hidden="true" />
              <span>{t("powerDraw")}</span>
              <span className="font-mono text-foreground ml-auto pl-3">
                {formatCount(powerSubtotal, ceilMode)}
              </span>
            </div>
          )}
          {utilization !== undefined && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <span>{t("utilization")}</span>
              <span className="font-mono text-foreground ml-auto pl-3">
                {Math.round(utilization * 100)}%
              </span>
            </div>
          )}
          {overCap && <div className="text-destructive">{overCapLabel}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
});

type RawMaterialStatCardProps = {
  item: Item;
  rate: number;
  pickupCount: number;
  facilities: Facility[];
  ceilMode: boolean;
  /**
   * `{used, cap}` when this raw has a limit (region default or user
   * override); `undefined` = unlimited. Over-cap is derived here
   * (`used > cap + ε`) — the map from `useProductionPlan` covers every
   * capped raw, not just overflowing ones.
   */
  capInfo: OverCapInfo;
};

/** Same epsilon as `computeRawOverCapWarnings` (plan-helpers). */
const CAP_EPSILON = 1e-9;

/**
 * Two-line raw-material row with a tier-colored left accent (matches
 * the target-card tier language): icon · name over `×count source` ·
 * right-aligned rate/min. Resolves the source-facility label from
 * `rawMaterialSources` internally so every host renders the same
 * wording.
 *
 * Capped raws add a capacity micro-bar along the bottom edge — the
 * unfilled remainder is the headroom the plan leaves on the table —
 * with exact used/limit/available numbers in a rich tooltip and an
 * sr-only mirror. Over-cap renders the same chrome as over-cap
 * facility rows (full destructive outline + AlertTriangle + red
 * number; here plus the full destructive bar) and keeps the focusable
 * `role="status"` pattern — the rows ARE the warning surface since
 * the cap banner strings were retired.
 */
export const RawMaterialStatCard = memo(function RawMaterialStatCard({
  item,
  rate,
  pickupCount,
  facilities,
  ceilMode,
  capInfo,
}: RawMaterialStatCardProps) {
  const { t } = useTranslation("stats");
  const cfg = rawMaterialSources.get(item.id);
  const sourceFacility = cfg
    ? facilities.find((f) => f.id === cfg.sourceFacility)
    : undefined;
  const sourceLabel = sourceFacility
    ? getFacilityName(sourceFacility)
    : t("pickupPoints");
  const overCap =
    capInfo !== undefined && capInfo.used > capInfo.cap + CAP_EPSILON;
  const headroom = capInfo ? Math.max(0, capInfo.cap - capInfo.used) : 0;
  const capFraction =
    capInfo && capInfo.cap > 0 ? Math.min(1, capInfo.used / capInfo.cap) : 1;
  const overCapAriaLabel = overCap
    ? t("rawCapExceeded", {
        used: capInfo.used.toFixed(1),
        cap: capInfo.cap,
      })
    : undefined;
  const row = (
    <div
      // Same a11y pattern as facility-over-cap rows: focusable +
      // aria-labelled so screen readers + keyboard nav surface the
      // over-cap detail.
      tabIndex={overCap ? 0 : undefined}
      role={overCap ? "status" : undefined}
      aria-label={overCapAriaLabel}
      className={cn(
        // Transparent 1px base border keeps layout stable when the
        // over-cap state swaps in the full destructive outline
        // (matching FacilityStatCard's over-cap chrome).
        "relative overflow-hidden flex items-center gap-2 border border-transparent border-l-2 rounded-r px-2 min-w-0",
        // Capped rows trade a whisker of bottom padding for the bar.
        capInfo ? "pt-1 pb-1.5" : "py-1",
        overCap
          ? "border-destructive/70 border-l-destructive bg-destructive/5"
          : cn("bg-muted/40", tierClasses(item.tier).border),
      )}
    >
      {item.iconUrl && (
        <img
          src={item.iconUrl}
          alt={getItemName(item)}
          className="w-5 h-5 object-contain shrink-0"
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium truncate">{getItemName(item)}</div>
        <div className="text-[11px] text-muted-foreground font-mono truncate">
          ×{formatCount(pickupCount, ceilMode)}
          <span className="ml-1">{sourceLabel}</span>
        </div>
      </div>
      {overCap && (
        <AlertTriangle
          className="h-3 w-3 text-destructive shrink-0"
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          "text-sm font-semibold font-mono shrink-0",
          overCap && "text-destructive",
        )}
      >
        {rate.toFixed(1)}
        <span className="text-[11px] font-normal text-muted-foreground ml-0.5">
          /min
        </span>
      </span>
      {capInfo && (
        <>
          {/* Capacity bar: fill = used/cap; the empty track remainder
              is the available headroom. Purely decorative — numbers
              live in the tooltip + sr-only text. */}
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-0.5 bg-border/40"
          >
            <div
              className={cn(
                "h-full",
                overCap
                  ? "bg-destructive"
                  : capFraction >= 0.9
                    ? "bg-amber-500 dark:bg-amber-400"
                    : "bg-muted-foreground/50",
              )}
              style={{ width: `${capFraction * 100}%` }}
            />
          </div>
          {!overCap && (
            <span className="sr-only">
              {`${t("limit")}: ${capInfo.cap}/min. ${t("available")}: ${headroom.toFixed(1)}/min.`}
            </span>
          )}
        </>
      )}
    </div>
  );
  if (!capInfo) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent variant="rich" sideOffset={4} className="p-2.5">
        <div className="space-y-1 text-xs">
          <div className="font-medium">
            {getItemName(item)}
            <span className="font-mono text-muted-foreground ml-1.5">
              {capInfo.used.toFixed(1)}/min
            </span>
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <span>{t("limit")}</span>
            <span className="font-mono text-foreground ml-auto pl-3">
              {capInfo.cap}/min
            </span>
          </div>
          {overCap ? (
            <div className="text-destructive">{overCapAriaLabel}</div>
          ) : (
            <div className="flex items-center gap-1 text-muted-foreground">
              <span>{t("available")}</span>
              <span className="font-mono text-foreground ml-auto pl-3">
                {headroom.toFixed(1)}/min
              </span>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
});

type ImportsListProps = {
  imports: readonly PlanMetastorageImport[];
  items: Item[];
};

/**
 * Metastorage transfer routes the calculator chose: one row per route
 * (item ← source region · rate/min), with a left accent in the source
 * region's color (same stripe language as the region picker). The TTV
 * budget detail lives in a tooltip only — whether the slot is 10% or
 * 90% used is irrelevant to planning (one route = one busy transfer
 * slot either way).
 */
export const ImportsList = memo(function ImportsList({
  imports,
  items,
}: ImportsListProps) {
  const { t } = useTranslation(["stats", "domain"]);
  if (imports.length === 0) return null;
  return (
    <div className="space-y-1">
      {imports.map((imp) => {
        const item = getItemById(items, imp.itemId);
        if (!item) return null;
        const domainColor = domains.find(
          (d) => d.id === imp.sourceDomain,
        )?.color;
        const ttvTitle = t("importTtvHint", {
          ns: "stats",
          used: (imp.ttvUsedPerMinute * (imp.cycleSeconds / 60)).toFixed(0),
          cap: (imp.ttvBudgetPerMinute * (imp.cycleSeconds / 60)).toFixed(0),
        });
        return (
          <div
            key={`${imp.sourceDomain}:${imp.itemId}`}
            className="flex items-center gap-1.5 text-xs border-l-2 rounded-r bg-muted/40 px-2 py-1.5 min-w-0"
            style={
              domainColor
                ? { borderLeftColor: `#${domainColor}` }
                : undefined
            }
            title={ttvTitle}
          >
            {item.iconUrl && (
              <img
                src={item.iconUrl}
                alt=""
                aria-hidden="true"
                className="w-4 h-4 object-contain shrink-0"
              />
            )}
            <span className="truncate flex-1 min-w-0">
              {getItemName(item)}
              <span className="text-muted-foreground ml-1">
                ← {t(`domains.${imp.sourceDomain}.name`, {
                  ns: "domain",
                  defaultValue: imp.sourceDomain,
                })}
              </span>
            </span>
            <span className="font-mono font-semibold shrink-0">
              {imp.ratePerMinute.toFixed(1)}
              <span className="text-muted-foreground font-normal">/min</span>
            </span>
          </div>
        );
      })}
    </div>
  );
});

type ByproductsListProps = {
  disposal: { item: Item; ratePerMinute: number }[];
};

/**
 * Byproduct disposal flows: what the plan must sink (Sewage Inlet /
 * Water Treatment), with per-item rates. One muted row per disposed
 * item.
 */
export const ByproductsList = memo(function ByproductsList({
  disposal,
}: ByproductsListProps) {
  if (disposal.length === 0) return null;
  return (
    <div className="space-y-1">
      {disposal.map(({ item, ratePerMinute }) => (
        <div
          key={item.id}
          className="flex items-center gap-1.5 text-xs rounded border border-border/40 bg-muted/40 px-2 py-1.5 min-w-0"
        >
          {item.iconUrl && (
            <img
              src={item.iconUrl}
              alt=""
              aria-hidden="true"
              className="w-4 h-4 object-contain shrink-0"
            />
          )}
          <span className="truncate flex-1 min-w-0">{getItemName(item)}</span>
          <ArrowRight
            className="h-3 w-3 text-muted-foreground shrink-0"
            aria-hidden="true"
          />
          <span className="font-mono font-semibold shrink-0">
            {ratePerMinute.toFixed(1)}
            <span className="text-muted-foreground font-normal">/min</span>
          </span>
        </div>
      ))}
    </div>
  );
});

type IssuesListProps = {
  error: string | null;
  warnings: string[];
  /** Extra layout classes on the list root — the root is a one-column
   *  grid, so hosts can add e.g. `xl:grid-cols-2` (dock strip). */
  className?: string;
};

/**
 * Full plan-issue list: the fatal `error` (destructive chrome) followed
 * by every solver warning (amber chrome). Each row carries a diagonal
 * hazard-stripe accent bar (currentColor, so it inherits the row's
 * severity color). Sole rendering site for the warnings strings — the
 * table/tree banners were retired in favour of this list living in the
 * stats surfaces (dock + portrait sheet).
 */
export const IssuesList = memo(function IssuesList({
  error,
  warnings,
  className,
}: IssuesListProps) {
  if (!error && warnings.length === 0) return null;
  return (
    <div className={cn("grid grid-cols-1 gap-1", className)}>
      {error && (
        <div className="relative flex items-start gap-2 text-destructive text-xs p-2 pl-3.5 bg-destructive/10 rounded overflow-hidden">
          <span
            className="hazard-stripe absolute inset-y-0 left-0 w-1.5 opacity-80"
            aria-hidden="true"
          />
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {warnings.map((msg, i) => (
        <div
          key={i}
          className="relative flex items-start gap-2 text-amber-600 dark:text-amber-400 text-xs p-2 pl-3.5 bg-amber-500/10 rounded overflow-hidden"
        >
          <span
            className="hazard-stripe absolute inset-y-0 left-0 w-1.5 opacity-80"
            aria-hidden="true"
          />
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{msg}</span>
        </div>
      ))}
    </div>
  );
});
