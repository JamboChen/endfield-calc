import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Shared layout for an interactive settings row, used by every sub-tab so
 * the four bodies share one density. Mobile-first: a >=44px touch target
 * (`min-h-[44px] py-2`) that tightens to ~34px on `sm:` and up
 * (`sm:min-h-0 sm:py-1.5`).
 *
 * Layout only — callers layer on their own background / hover / state
 * classes (locked dimming, override highlight, cursor) via
 * `cn(settingsRowClass, ...)`. Keeping state out of the constant avoids
 * dead hover styles on disabled rows.
 */
export const settingsRowClass =
  "flex items-center gap-2 px-2 rounded text-sm min-h-[44px] py-2 sm:min-h-0 sm:py-1.5";

interface SettingsCardProps {
  /** Section/card title. */
  title?: ReactNode;
  /** Leading `size-6` icon node (optional). */
  icon?: ReactNode;
  /** Trailing count/value pill in the header (optional). */
  badge?: ReactNode;
  /**
   * Header-right action buttons (optional). For collapsible cards these
   * render OUTSIDE the trigger so clicking them doesn't toggle the card
   * (you can't nest a <button> inside the trigger <button>).
   */
  actions?: ReactNode;
  /** Chevron + Radix Collapsible. Default: a static titled header bar. */
  collapsible?: boolean;
  /** Controlled open state (collapsible only). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}

/**
 * The single card chrome shared by every Settings sub-tab (Plan / Limits /
 * Resources / Structures). The header is a flex row so `actions` sit
 * beside the title and reflow cleanly — this replaces the
 * absolute-positioned action-button hack the Plan / Limits cards used
 * before.
 */
export function SettingsCard({
  title,
  icon,
  badge,
  actions,
  collapsible = false,
  open,
  onOpenChange,
  className,
  children,
}: SettingsCardProps) {
  const cardClass = cn(
    "rounded-md border border-border/60 bg-background/40",
    collapsible && open && "shadow-xs",
    className,
  );

  const headerInner = (
    <>
      {icon}
      <span className="text-sm font-medium flex-1 min-w-0 truncate">
        {title}
      </span>
      {badge}
    </>
  );

  const actionSlot = actions ? (
    <div className="shrink-0 pr-2 flex items-center gap-1">{actions}</div>
  ) : null;

  if (collapsible) {
    return (
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className={cardClass}>
          <div className="flex items-stretch min-h-[44px]">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-left rounded-md",
                  "hover:bg-accent/40 dark:hover:bg-accent/30 transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                )}
                aria-expanded={open}
              >
                <ChevronDown
                  className={cn(
                    "size-4 text-muted-foreground transition-transform shrink-0",
                    open ? "rotate-0" : "-rotate-90",
                  )}
                />
                {headerInner}
              </button>
            </CollapsibleTrigger>
            {actionSlot}
          </div>
          <CollapsibleContent>
            <div className="p-2">{children}</div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    );
  }

  return (
    <div className={cardClass}>
      <div className="flex items-stretch min-h-[44px] border-b border-border/40">
        <div className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2">
          {headerInner}
        </div>
        {actionSlot}
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}
