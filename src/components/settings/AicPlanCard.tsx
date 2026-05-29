import { useMemo, useState } from "react";
import { ChevronDown, Check, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AicLayerList } from "./AicLayer";
import { AicFacilityLimits } from "./AicFacilityLimits";
import type {
  AicGroup,
  AicLayer,
  AicNode,
  AicTechId,
  FacilityBaseCap,
} from "@/types/aic";
import type { DomainId } from "@/types/domain";
import type { FacilityId } from "@/types";

interface AicPlanCardProps {
  group: AicGroup;
  layers: readonly AicLayer[];
  nodes: readonly AicNode[];
  researched: ReadonlySet<AicTechId>;
  baseCaps: readonly FacilityBaseCap[];
  capOverrides: ReadonlyMap<string, number>;
  effectiveCaps: ReadonlyMap<FacilityId, ReadonlyMap<DomainId, number>>;
  /**
   * Per-plan "at defaults" flag. When true, the Reset button hides — the
   * plan is already in its game-default state, so resetting is a no-op.
   * Mirrors the Activate-all button's hide-when-allDone behaviour.
   */
  isAtDefaults: boolean;
  onToggleNode: (id: AicTechId) => void;
  onActivateLayer: (layerId: string) => void;
  onActivateGroup: () => void;
  onResetGroup: () => void;
  onSetCapOverride: (
    facilityId: FacilityId,
    domainId: DomainId,
    value: number | null,
  ) => void;
  /**
   * Bulk-activate a set of cap-raise tech ids (with prereq cascade).
   * Wired by the per-facility Check button inside `AicFacilityLimits`.
   * Forwarded as-is from the parent hook's `activateNodes`.
   */
  onActivateRaiseNodes: (ids: readonly AicTechId[]) => void;
}

/**
 * One AIC Plan card — sits inside a `DomainSection`. The card itself is
 * AIC-specific (renders the plan's layers + facility-limits); the parent
 * `DomainSection` handles the domain-level chrome (activation toggle,
 * accent stripe, name).
 *
 * Future per-domain settings categories should follow the same pattern:
 * create a sibling card component (e.g. `RegionLimitsCard`) hosted inside
 * the same `DomainSection`.
 */
export function AicPlanCard({
  group,
  layers,
  nodes,
  researched,
  baseCaps,
  capOverrides,
  effectiveCaps,
  isAtDefaults,
  onToggleNode,
  onActivateLayer,
  onActivateGroup,
  onResetGroup,
  onSetCapOverride,
  onActivateRaiseNodes,
}: AicPlanCardProps) {
  const { t } = useTranslation(["aic", "settings"]);
  const [open, setOpen] = useState(false);

  const groupLayers = useMemo(
    () => layers.filter((l) => l.groupId === group.id),
    [layers, group.id],
  );

  const groupNodes = useMemo(
    () => nodes.filter((n) => n.groupId === group.id),
    [nodes, group.id],
  );

  // Bucket nodes by layer for the layer list (capRaise nodes go to the
  // Facility-limits section instead).
  const { nodesByLayer, capRaiseNodes, researchableCount, researchedCount } =
    useMemo(() => {
      const byLayer = new Map<string, AicNode[]>();
      const caps: AicNode[] = [];
      let total = 0;
      let done = 0;
      for (const node of groupNodes) {
        if (node.action.kind === "capRaise") {
          caps.push(node);
          continue;
        }
        total++;
        if (researched.has(node.id)) done++;
        let bucket = byLayer.get(node.layerId);
        if (!bucket) {
          bucket = [];
          byLayer.set(node.layerId, bucket);
        }
        bucket.push(node);
      }
      return {
        nodesByLayer: byLayer,
        capRaiseNodes: caps,
        researchableCount: total,
        researchedCount: done,
      };
    }, [groupNodes, researched]);

  const groupName = t(`groups.${group.id}.name`, {
    ns: "aic",
    defaultValue: group.id,
  });

  const allDone = researchedCount === researchableCount;

  // No accent stripe on the card itself — the parent `DomainSection`
  // carries the domain-level accent. Keeping the card visually plain
  // lets multiple sibling cards (today: 1; future: more categories) sit
  // inside one domain without competing accents.

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "rounded-lg border bg-card/60 backdrop-blur-sm",
          open && "shadow-sm",
        )}
      >
        {/*
         * Header hosts the expand-trigger plus two inline action buttons
         * (Activate all + Reset). Buttons are siblings of the trigger in a
         * `relative` container with `absolute` positioning to dodge nesting
         * (you can't nest a <button> inside a <button>). Each action button
         * calls `stopPropagation` so it never accidentally toggles the
         * collapsible.
         *
         * Activate-all auto-hides when the plan is fully researched; Reset
         * is always available (re-applying defaults to a default state is
         * harmless, and serves as a visible "you can do this" affordance).
         */}
        <div className="relative flex items-stretch">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className={cn(
                "w-full flex items-center gap-3 px-3 py-3 min-h-[52px]",
                // Reserve trailing space so the count badge doesn't crash
                // into the action buttons. Two buttons = ~5rem trailing pad.
                "pr-[5.5rem]",
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
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold leading-tight">
                  {groupName}
                </div>
              </div>
              <span
                className={cn(
                  "text-[11px] tabular-nums font-medium rounded px-2 py-0.5 shrink-0",
                  allDone
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {researchedCount}/{researchableCount}
              </span>
            </button>
          </CollapsibleTrigger>
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {!allDone && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "size-8 text-muted-foreground hover:text-foreground",
                  "hover:bg-accent/80",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onActivateGroup();
                }}
                aria-label={t("aic.activateAll", {
                  ns: "settings",
                  defaultValue: "Activate all",
                })}
                title={t("aic.activateAll", {
                  ns: "settings",
                  defaultValue: "Activate all",
                })}
              >
                <Check className="size-4" />
              </Button>
            )}
            {!isAtDefaults && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "size-8 text-muted-foreground hover:text-foreground",
                  "hover:bg-accent/80",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onResetGroup();
                }}
                aria-label={t("aic.resetDefaults", {
                  ns: "settings",
                  defaultValue: "Reset to defaults",
                })}
                title={t("aic.resetDefaults", {
                  ns: "settings",
                  defaultValue: "Reset to defaults",
                })}
              >
                <Undo2 className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <CollapsibleContent>
          <div className="px-3 pb-3 pt-1 space-y-3">
            {/* Layer stack */}
            <AicLayerList
              layers={groupLayers}
              nodesByLayer={nodesByLayer}
              researched={researched}
              onToggleNode={onToggleNode}
              onActivateLayer={onActivateLayer}
            />

            {/* Facility limits section */}
            {capRaiseNodes.length > 0 && (
              <AicFacilityLimits
                capRaiseNodes={capRaiseNodes}
                researched={researched}
                baseCaps={baseCaps}
                capOverrides={capOverrides}
                effectiveCaps={effectiveCaps}
                onToggle={onToggleNode}
                onSetCapOverride={onSetCapOverride}
                onActivateRaiseNodes={onActivateRaiseNodes}
              />
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
