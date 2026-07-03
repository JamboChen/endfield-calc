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
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn, formatCount } from "@/lib/utils";

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
  /** Σ effective buildings (ceilMode-adjusted; format via formatCount). */
  totalBuildings: number;
  /** Σ build-grid tiles (always whole; a lower bound — belts excluded). */
  totalTiles: number;
  /** Depot-bus unloader ports — the community-consensus hard throughput
   *  cap. Pumps are deliberately NOT in this number (open-world
   *  placements); they surface in the expanded raw-materials section. */
  depotPickupPoints: number;
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
 * Slim always-visible production-summary strip. Shared between the
 * landscape `BottomDock` (collapsed state + expanded header) and the
 * portrait drawer trigger — one visual language for "the plan at a
 * glance". Stat lineup targets the constraints AIC planners budget
 * against: power draw, building count, build-grid tiles, and depot
 * ports; plus a destructive issue badge covering every solver warning
 * and the calc error.
 *
 * Rest props (incl. `ref` — React 19) are spread onto the root button
 * AFTER the ticker's own attributes, so a Radix `asChild` wrapper's
 * injected `onClick` / `aria-*` / `data-*` win when present.
 */
const StatsTicker = memo(function StatsTicker({
  totalPowerConsumption,
  totalBuildings,
  totalTiles,
  depotPickupPoints,
  issueCount,
  ceilMode,
  error,
  expanded,
  onToggle,
  className,
  ...rest
}: StatsTickerProps) {
  const { t } = useTranslation("stats");
  const Chevron = expanded ? ChevronDown : ChevronUp;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={t("title")}
      className={cn(
        "w-full flex items-center gap-x-4 px-4 py-2 text-sm transition-colors hover:bg-accent/50 cursor-pointer",
        className,
      )}
      {...rest}
    >
      {issueCount > 0 && (
        <span
          className="flex items-center gap-1 text-destructive shrink-0"
          title={t("issues")}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="font-mono font-medium">{issueCount}</span>
          <span className="sr-only">{t("issues")}</span>
        </span>
      )}
      {error ? (
        <span className="flex items-center gap-1.5 text-destructive min-w-0">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{error}</span>
        </span>
      ) : (
        <>
          <TickerStat
            icon={Zap}
            label={t("totalPower")}
            value={totalPowerConsumption.toFixed(1)}
          />
          <TickerStat
            icon={Factory}
            label={t("buildings")}
            value={formatCount(totalBuildings, ceilMode)}
          />
          <TickerStat
            icon={LayoutGrid}
            label={t("gridArea")}
            value={totalTiles > 0 ? `≥${totalTiles}` : 0}
            title={t("gridAreaHint")}
          />
          <TickerStat
            icon={Plug}
            label={t("depotPorts")}
            value={formatCount(depotPickupPoints, ceilMode)}
          />
        </>
      )}
      <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground shrink-0">
        <span className="hidden sm:inline">
          {expanded ? t("collapse") : t("showDetails")}
        </span>
        <Chevron className="h-4 w-4" aria-hidden="true" />
      </span>
    </button>
  );
});

export default StatsTicker;
