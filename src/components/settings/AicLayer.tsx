import { useMemo } from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  AicLayerId,
  AicLayer as AicLayerType,
  AicNode,
  AicTechId,
} from "@/types/aic";

import { AicNodeRow } from "./AicNodeRow";
import { SettingsCard } from "./SettingsCard";

interface AicLayerProps {
  layer: AicLayerType;
  nodes: readonly AicNode[];
  researched: ReadonlySet<AicTechId>;
  /** Controlled expand state — owned by `AicPlanGroup` so an
   * expand/collapse-all toggle can drive every layer at once. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (id: AicTechId) => void;
  onActivateLayer: () => void;
  /** Read-only shared-view: node ids whose researched state differs from own. */
  changedNodes?: ReadonlySet<AicTechId>;
}

function AicLayerSection({
  layer,
  nodes,
  researched,
  open,
  onOpenChange,
  onToggle,
  onActivateLayer,
  changedNodes,
}: AicLayerProps) {
  const { t } = useTranslation(["aic", "settings"]);
  // `changedNodes` is threaded only in read-only shared-view (undefined
  // in normal mode), so its presence is the read-only signal.
  const readOnly = changedNodes !== undefined;

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

  const badge = (
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
  );

  return (
    <SettingsCard
      collapsible
      open={open}
      onOpenChange={onOpenChange}
      title={layerName}
      badge={badge}
      actions={
        allDone || readOnly ? undefined : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-9 sm:size-7 text-muted-foreground hover:text-foreground hover:bg-accent/80"
            onClick={onActivateLayer}
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
        )
      }
    >
      <div className="space-y-0.5">
        {researchableNodes.map((node) => (
          <AicNodeRow
            key={node.id}
            node={node}
            researched={researched}
            onToggle={onToggle}
            changed={changedNodes?.has(node.id) ?? false}
            readOnly={readOnly}
          />
        ))}
      </div>
    </SettingsCard>
  );
}

interface AicLayerListProps {
  layers: readonly AicLayerType[];
  nodesByLayer: ReadonlyMap<string, AicNode[]>;
  researched: ReadonlySet<AicTechId>;
  /** Ids of currently-expanded layers (controlled by `AicPlanGroup`). */
  openLayers: ReadonlySet<AicLayerId>;
  onLayerOpenChange: (layerId: AicLayerId, open: boolean) => void;
  onToggleNode: (id: AicTechId) => void;
  onActivateLayer: (layerId: string) => void;
  /** Read-only shared-view: node ids whose researched state differs from own. */
  changedNodes?: ReadonlySet<AicTechId>;
}

/**
 * Renders all layers of a plan in ascending order (I → II → III).
 */
export function AicLayerList({
  layers,
  nodesByLayer,
  researched,
  openLayers,
  onLayerOpenChange,
  onToggleNode,
  onActivateLayer,
  changedNodes,
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
            open={openLayers.has(layer.id)}
            onOpenChange={(o) => onLayerOpenChange(layer.id, o)}
            onToggle={onToggleNode}
            onActivateLayer={() => onActivateLayer(layer.id)}
            changedNodes={changedNodes}
          />
        );
      })}
    </div>
  );
}
