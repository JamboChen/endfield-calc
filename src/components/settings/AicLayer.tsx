import { useMemo, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AicLayer as AicLayerType, AicNode, AicTechId } from "@/types/aic";

import { AicNodeRow } from "./AicNodeRow";

interface AicLayerProps {
  layer: AicLayerType;
  nodes: readonly AicNode[];
  researched: ReadonlySet<AicTechId>;
  onToggle: (id: AicTechId) => void;
  onActivateLayer: () => void;
}

function AicLayerSection({
  layer,
  nodes,
  researched,
  onToggle,
  onActivateLayer,
}: AicLayerProps) {
  const { t } = useTranslation(["aic", "settings"]);

  // Layers with <= 2 nodes auto-expand (no point hiding 1 row behind a chevron).
  const initialOpen = nodes.length <= 2;
  const [open, setOpen] = useState(initialOpen);

  // Count facility-unlock + mode-unlock nodes only — cap-raises live in the
  // Facility-limits section, so they shouldn't double up the layer count.
  const researchableNodes = useMemo(
    () => nodes.filter((n) => n.action.kind !== "capRaise"),
    [nodes],
  );
  const researchedCount = useMemo(
    () => researchableNodes.filter((n) => researched.has(n.id)).length,
    [researchableNodes, researched],
  );
  const allDone = researchedCount === researchableNodes.length;

  const layerName = t(`layers.${layer.id}.name`, {
    ns: "aic",
    defaultValue: layer.id,
  });

  if (researchableNodes.length === 0) {
    // Pure cap-raise layer — nothing to show in the main tree.
    return null;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "rounded-md border border-border/60 bg-background/40",
          open && "shadow-xs",
        )}
      >
        {/*
         * Header row hosts BOTH the expand-trigger and the inline
         * "Activate layer" button. Layout: expand-trigger fills the row;
         * the Activate button sits absolutely-aligned to the right (or as
         * a sibling on the same flex row) with stopPropagation so clicks
         * activate the layer without toggling the collapsible.
         *
         * We can't nest a <button> inside the CollapsibleTrigger button,
         * so the Activate button is rendered AFTER the CollapsibleTrigger
         * within a parent flex container — Tailwind's `relative` + an
         * absolute-positioned action button keeps both clickable.
         */}
        <div className="relative flex items-stretch">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 min-h-[44px]",
                // Reserve trailing space for the Activate button so the
                // count badge doesn't collide with it when present.
                !allDone && "pr-12",
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
              <span className="text-sm font-medium flex-1 min-w-0 truncate">
                {layerName}
              </span>
              <span
                className={cn(
                  "text-[11px] tabular-nums font-medium rounded px-1.5 py-0.5 shrink-0",
                  allDone
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {researchedCount}/{researchableNodes.length}
              </span>
            </button>
          </CollapsibleTrigger>
          {!allDone && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn(
                "absolute right-2 top-1/2 -translate-y-1/2 size-7",
                "text-muted-foreground hover:text-foreground",
                "hover:bg-accent/80",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onActivateLayer();
              }}
              aria-label={t("aic.activateLayer", {
                ns: "settings",
                defaultValue: "Activate layer",
              })}
              title={t("aic.activateLayer", {
                ns: "settings",
                defaultValue: "Activate layer",
              })}
            >
              <Check className="size-3.5" />
            </Button>
          )}
        </div>
        <CollapsibleContent>
          <div className="px-2 pb-2 pt-1 space-y-0.5">
            {researchableNodes.map((node) => (
              <AicNodeRow
                key={node.id}
                node={node}
                researched={researched}
                onToggle={onToggle}
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

interface AicLayerListProps {
  layers: readonly AicLayerType[];
  nodesByLayer: ReadonlyMap<string, AicNode[]>;
  researched: ReadonlySet<AicTechId>;
  onToggleNode: (id: AicTechId) => void;
  onActivateLayer: (layerId: string) => void;
}

/**
 * Renders all layers of a plan in ascending order (I → II → III).
 */
export function AicLayerList({
  layers,
  nodesByLayer,
  researched,
  onToggleNode,
  onActivateLayer,
}: AicLayerListProps) {
  const ordered = useMemo(
    () => [...layers].sort((a, b) => a.order - b.order),
    [layers],
  );

  return (
    <div className="space-y-2">
      {ordered.map((layer) => {
        const layerNodes = nodesByLayer.get(layer.id) ?? [];
        return (
          <AicLayerSection
            key={layer.id}
            layer={layer}
            nodes={layerNodes}
            researched={researched}
            onToggle={onToggleNode}
            onActivateLayer={() => onActivateLayer(layer.id)}
          />
        );
      })}
    </div>
  );
}
