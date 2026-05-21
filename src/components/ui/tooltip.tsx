import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  )
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

/**
 * Two variants:
 *
 *   - `default` — the original inverted speech-bubble style. Designed for
 *     short, single-line hints (`bg-foreground text-background`, fixed
 *     cosy padding, with an arrow). Use for one-liners like "Save plan",
 *     "Always available", aria descriptions, etc.
 *   - `rich` — a card-style surface for multi-section content
 *     (`bg-popover text-popover-foreground`, border + shadow, no padding,
 *     no arrow). The caller controls internal layout / padding. Use for
 *     anything richer than a single line: structured headers, scrollable
 *     lists, etc. The non-inverted palette means `text-foreground` and
 *     `text-muted-foreground` inside render with correct contrast.
 */
function TooltipContent({
  className,
  sideOffset = 0,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  variant?: "default" | "rich"
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        data-variant={variant}
        sideOffset={sideOffset}
        className={cn(
          // Shared: layout, animations, base typography
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md text-xs text-balance",
          // Default: inverted speech-bubble with cosy padding
          variant === "default" && "bg-foreground text-background px-3 py-1.5",
          // Rich: card-style surface — caller owns padding
          variant === "rich" &&
            "bg-popover text-popover-foreground border border-border shadow-md",
          className
        )}
        {...props}
      >
        {children}
        {variant === "default" && (
          <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
