import { cn } from "@/lib/utils";

type SectionHeaderProps = {
  label: string;
  /** Count badge in the dock-grammar slot right after the label —
   *  plain numbers (dock sections) or formatted strings ("4 / 12"). */
  count?: React.ReactNode;
  /** Right-aligned muted caption (e.g. "19 pumps"). */
  caption?: React.ReactNode;
  /** Right-most slot for interactive chrome (buttons); unlike
   *  `caption` it is not muted/truncated. */
  action?: React.ReactNode;
  className?: string;
};

/**
 * Section micro-label with the telemetry gold tick — the shared
 * "named section" marker of the stats/plan design family. Used by the
 * BottomDock zones, the portrait stats sheet (via `stat-sections`),
 * and the plan rail's Targets/Options sections. Plain uppercase
 * micro-labels WITHOUT the tick denote field/group labels nested
 * inside a section (e.g. "Structures" inside Options).
 *
 * `items-center` (not baseline) on purpose: rows can carry tall
 * action buttons, and the tick must stay geometrically centered
 * against the label at any row height.
 */
export function SectionHeader({
  label,
  count,
  caption,
  action,
  className,
}: SectionHeaderProps) {
  return (
    <div className={cn("mb-2 flex items-center gap-2 min-w-0", className)}>
      <span
        className="h-2.5 w-0.5 shrink-0 rounded-full bg-stats-accent"
        aria-hidden="true"
      />
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      {count !== undefined && (
        <span className="font-mono text-xs text-muted-foreground">
          {count}
        </span>
      )}
      {caption !== undefined && (
        <span className="ml-auto min-w-0 truncate text-right text-[11px] font-normal text-muted-foreground">
          {caption}
        </span>
      )}
      {action !== undefined && (
        <span
          className={cn(
            "flex items-center shrink-0",
            // Caption already claimed the flexible middle; otherwise
            // the action pushes itself to the right edge.
            caption === undefined && "ml-auto",
          )}
        >
          {action}
        </span>
      )}
    </div>
  );
}
