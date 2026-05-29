import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Domain } from "@/types/domain";

interface DomainSectionProps {
  domain: Domain;
  isActive: boolean;
  /**
   * Activation toggle handler. Called on switch flip (unless the domain
   * is pinned, in which case the switch is hidden entirely).
   */
  onToggle: () => void;
  /**
   * Per-domain settings cards (today: AIC Plan card; future: region
   * limits, power budget, …). Rendered inside the section body. When the
   * domain is inactive, the children are visually disabled but kept in
   * the DOM (soft preservation — re-activating the domain restores the
   * exact UI state).
   */
  children: ReactNode;
}

/**
 * Generic wrapper for one domain's settings section.
 *
 * Responsibilities:
 *   - render the domain name (from the `domain` i18n namespace) and the
 *     accent stripe (color from `Domain.color`)
 *   - render the activation `Switch` (hidden for pinned domains like
 *     Valley IV); the switch is interactive whether or not the section
 *     is expanded — toggling activation never depends on first opening
 *     the section.
 *   - collapse/expand the body via the header chevron. Default is
 *     collapsed (uniform — active and inactive domains alike). The
 *     switch is a sibling of the trigger (positioned absolutely) with
 *     `stopPropagation` so flipping it doesn't toggle the collapse.
 *   - grey the body when the domain is inactive — children stay in the
 *     DOM (soft preservation of nested card state).
 *
 * Category-agnostic: hosts arbitrary `children` (currently `AicPlanCard`,
 * later sibling cards for new per-domain categories).
 */
export function DomainSection({
  domain,
  isActive,
  onToggle,
  children,
}: DomainSectionProps) {
  const { t } = useTranslation(["domain", "settings"]);
  const [open, setOpen] = useState(false);

  const domainName = t(`domains.${domain.id}.name`, {
    ns: "domain",
    defaultValue: domain.id,
  });

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section
        aria-label={domainName}
        className={cn(
          "rounded-lg border-l-4 bg-card/40",
          open && "shadow-xs",
        )}
        style={{ borderLeftColor: `#${domain.color}` }}
      >
        <div className="relative flex items-stretch">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2.5 min-h-[44px]",
                // Reserve trailing space for the activation switch on
                // non-pinned domains. Pinned domains have no switch so
                // the badge area can be flush right.
                !domain.isPinned && "pr-14",
                "text-left rounded-md",
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
              <h3 className="flex-1 min-w-0 text-sm font-semibold tracking-tight truncate">
                {domainName}
              </h3>
            </button>
          </CollapsibleTrigger>
          {!domain.isPinned && (
            <div
              className="absolute right-3 top-1/2 -translate-y-1/2"
              // Stop propagation at the wrapper so any click that lands
              // on the switch (or its padding) never toggles the collapse.
              onClick={(e) => e.stopPropagation()}
            >
              <Switch
                checked={isActive}
                onCheckedChange={onToggle}
                aria-label={
                  isActive
                    ? t("aic.domain.toggleDeactivate", {
                        ns: "settings",
                        name: domainName,
                        defaultValue: `Deactivate ${domainName}`,
                      })
                    : t("aic.domain.toggleActivate", {
                        ns: "settings",
                        name: domainName,
                        defaultValue: `Activate ${domainName}`,
                      })
                }
              />
            </div>
          )}
        </div>
        <CollapsibleContent>
          <div className="px-3 pb-3 pt-1 space-y-3">
            {isActive ? (
              children
            ) : (
              <div
                className="opacity-50 pointer-events-none select-none space-y-3"
                aria-hidden="true"
              >
                {children}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
