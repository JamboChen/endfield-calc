import type { ReactNode } from "react";
import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Muted ⓘ button that opens a floating hint card on click/tap.
 *
 * The touch-capable replacement for inline hint paragraphs and for
 * hover tooltips on hint content: Radix tooltips never open on touch,
 * so any hint that must be reachable on mobile goes through this
 * (Popover opens on tap and dismisses on outside-tap/Escape — one
 * interaction model on every platform).
 *
 * Trigger chrome matches the AIC research rows' info button
 * (`AicNodeRow.tsx`): `size-7` hit target, `size-4` glyph, muted →
 * foreground on hover. `-my-1` keeps the 28px target from inflating
 * text-sm rows.
 */
export function InfoHint({
  ariaLabel,
  children,
}: {
  /** Accessible name for the trigger — pass a per-row label (e.g.
   *  `t("optionInfo", { label })`), not a bare generic "info". */
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="size-7 -my-1 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/80 transition-colors shrink-0"
        >
          <Info className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="max-w-64 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
