import { memo, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Factory,
  LayoutGrid,
  Plug,
  Route,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn, formatCount } from "@/lib/utils";
import { KpiBlock } from "../production/stat-sections";

type TickerStatProps = {
  icon: LucideIcon;
  label: string;
  value: string | number;
  title?: string;
};

/** One inline stat: icon + mono value, label revealed at `md:` widths. */
function TickerStat({ icon: Icon, label, value, title }: TickerStatProps) {
  return (
    <span
      className="flex items-center gap-1.5 text-muted-foreground min-w-0"
      title={title}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="font-medium text-foreground font-mono">{value}</span>
      <span className="hidden md:inline text-xs truncate">{label}</span>
    </span>
  );
}

type StatsTickerOwnProps = {
  totalPowerConsumption: number;
  /** Σ watts provided by Thermal Banks (self-sustaining power). When
   *  > 0 the power stat renders as `consumption / generation`. */
  totalPowerGeneration?: number;
  /** Σ effective buildings (ceilMode-adjusted; format via formatCount). */
  totalBuildings: number;
  /** Σ build-grid tiles (always whole; a lower bound — belts excluded). */
  totalTiles: number;
  /** Depot-bus unloader ports — the community-consensus hard throughput
   *  cap. Pumps are deliberately NOT in this number (open-world
   *  placements); they surface in the raw-materials section. */
  depotPickupPoints: number;
  /** Non-raw item nodes with visible rate — hero-variant KPI only. */
  uniqueProductionSteps: number;
  /** All plan issues: warnings + calc error, surfaced as a destructive
   *  badge. */
  issueCount: number;
  ceilMode: boolean;
  /** Calc error message. When set, replaces the stat row (the numbers
   *  are all zeros in that state anyway) so the failure is visible even
   *  while the host's detail surface is collapsed/closed. */
  error?: string | null;
  /**
   * Whether the host's detail surface is currently shown. Drives the
   * chevron direction, the action label (Details ⇄ Collapse) and
   * `aria-expanded`.
   */
  expanded: boolean;
  /**
   * Display density. `slim` is the original one-line ticker (collapsed
   * dock, portrait drawer trigger); `hero` renders the stats as large
   * telemetry KPI blocks — the expanded dock's header, where the strip
   * doubles as the plan's headline readout.
   */
  variant?: "slim" | "hero";
  /** Click handler. Optional: when the ticker is wrapped in a Radix
   *  trigger (`SheetTrigger asChild`), the trigger's own injected
   *  `onClick` (spread via rest props) drives it instead. */
  onToggle?: () => void;
  /** Extra chrome (border/rounding/bg) supplied by the host. */
  className?: string;
};

type StatsTickerProps = StatsTickerOwnProps &
  Omit<ComponentProps<"button">, keyof StatsTickerOwnProps>;

/**
 * Always-visible production-summary strip. Shared between the landscape
 * `BottomDock` (slim when collapsed, hero when expanded) and the
 * portrait drawer trigger (always slim) — one visual language for "the
 * plan at a glance". Stat lineup targets the constraints AIC planners
 * budget against: power draw, building count, build-grid tiles, and
 * depot ports (+ production steps in hero); plus a destructive issue
 * badge covering every solver warning and the calc error.
 *
 * Rest props (incl. `ref` — React 19) are spread onto the root button
 * AFTER the ticker's own attributes, so a Radix `asChild` wrapper's
 * injected `onClick` / `aria-*` / `data-*` win when present.
 */
const StatsTicker = memo(function StatsTicker({
  totalPowerConsumption,
  totalPowerGeneration = 0,
  totalBuildings,
  totalTiles,
  depotPickupPoints,
  uniqueProductionSteps,
  issueCount,
  ceilMode,
  error,
  expanded,
  variant = "slim",
  onToggle,
  className,
  ...rest
}: StatsTickerProps) {
  const { t } = useTranslation("stats");
  const Chevron = expanded ? ChevronDown : ChevronUp;
  const hero = variant === "hero";
  // Self-sustaining power: surface both sides of the balance as
  // `consumption / generation` under the Zap stat.
  const powerValue =
    totalPowerGeneration > 0
      ? `${totalPowerConsumption.toFixed(1)} / ${totalPowerGeneration.toFixed(1)}`
      : totalPowerConsumption.toFixed(1);
  const powerLabel =
    totalPowerGeneration > 0 ? t("powerBalance") : t("totalPower");

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={t("title")}
      className={cn(
        "w-full flex items-center px-4 text-sm transition-colors hover:bg-accent/50 cursor-pointer",
        hero ? "gap-x-6 py-3" : "gap-x-4 py-2",
        className,
      )}
      {...rest}
    >
      {issueCount > 0 &&
        (hero ? (
          <span className="min-w-0 shrink-0 text-left text-destructive">
            <span className="flex items-baseline gap-1.5">
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0 self-center"
                aria-hidden="true"
              />
              <span className="font-mono font-semibold tabular-nums leading-none tracking-tight text-2xl">
                {issueCount}
              </span>
            </span>
            <span className="mt-1 block text-[10px] uppercase tracking-[0.14em]">
              {t("issues")}
            </span>
          </span>
        ) : (
          <span
            className="flex items-center gap-1 text-destructive shrink-0"
            title={t("issues")}
          >
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="font-mono font-medium">{issueCount}</span>
            <span className="sr-only">{t("issues")}</span>
          </span>
        ))}
      {error ? (
        <span className="flex items-center gap-1.5 text-destructive min-w-0">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{error}</span>
        </span>
      ) : hero ? (
        // Hairlines via per-block border-l (not divide-x) so the
        // responsively-hidden Steps block can't leave a trailing rule.
        <div className="flex items-center min-w-0 overflow-hidden text-left">
          <KpiBlock
            hero
            icon={Zap}
            label={powerLabel}
            value={powerValue}
            className="px-6 first:pl-0 border-l border-border/60 first:border-l-0"
          />
          <KpiBlock
            hero
            icon={Factory}
            label={t("buildings")}
            value={formatCount(totalBuildings, ceilMode)}
            className="px-6 first:pl-0 border-l border-border/60 first:border-l-0"
          />
          <KpiBlock
            hero
            icon={LayoutGrid}
            label={t("gridArea")}
            value={totalTiles > 0 ? `≥${totalTiles}` : "0"}
            title={t("gridAreaHint")}
            className="px-6 first:pl-0 border-l border-border/60 first:border-l-0"
          />
          <KpiBlock
            hero
            icon={Plug}
            label={t("depotPorts")}
            value={formatCount(depotPickupPoints, ceilMode)}
            className="px-6 first:pl-0 border-l border-border/60 first:border-l-0"
          />
          <KpiBlock
            hero
            icon={Route}
            label={t("productionSteps")}
            value={String(uniqueProductionSteps)}
            className="px-6 first:pl-0 border-l border-border/60 first:border-l-0 hidden lg:block"
          />
        </div>
      ) : (
        <>
          <TickerStat
            icon={Zap}
            label={powerLabel}
            value={powerValue}
          />
          <TickerStat
            icon={Factory}
            label={t("buildings")}
            value={formatCount(totalBuildings, ceilMode)}
          />
          <TickerStat
            icon={LayoutGrid}
            label={t("gridArea")}
            value={totalTiles > 0 ? `≥${totalTiles}` : "0"}
            title={t("gridAreaHint")}
          />
          <TickerStat
            icon={Plug}
            label={t("depotPorts")}
            value={formatCount(depotPickupPoints, ceilMode)}
          />
        </>
      )}
      <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground shrink-0 self-center">
        <span className="hidden sm:inline">
          {expanded ? t("collapse") : t("showDetails")}
        </span>
        <Chevron className="h-4 w-4" aria-hidden="true" />
      </span>
    </button>
  );
});

export default StatsTicker;
