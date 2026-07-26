import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsDownUp, ChevronsUpDown, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { useSettingsFocus } from "@/contexts/settings-focus-context";
import { cn } from "@/lib/utils";
import { AicLayerList } from "./AicLayer";
import type {
  AicGroup,
  AicGroupId,
  AicLayer,
  AicLayerId,
  AicNode,
  AicTechId,
} from "@/types/aic";

interface AicPlanContentProps {
  /** Groups belonging to the edited region (already domain-filtered). */
  groups: readonly AicGroup[];
  layers: readonly AicLayer[];
  nodes: readonly AicNode[];
  researched: ReadonlySet<AicTechId>;
  isAtDefaultsByGroup: ReadonlyMap<AicGroupId, boolean>;
  onToggleNode: (id: AicTechId) => void;
  onActivateLayer: (layerId: string) => void;
  onActivateGroup: (groupId: AicGroupId) => void;
  onResetGroup: (groupId: AicGroupId) => void;
  /** Read-only shared-view: node ids whose researched state differs from own. */
  changedNodes?: ReadonlySet<AicTechId>;
  /** Freezes the controls. Explicit rather than inferred from
   *  `changedNodes`, which is for accents and may legitimately be empty. */
  readOnly?: boolean;
}

/**
 * AIC plan content for one region — the body of the "Plan" sub-tab.
 * Renders every AIC plan group in the region stacked; each group has a
 * header (name + researched count + activate-all + reset) followed by
 * its collapsible layer tree. Cap-raise nodes are excluded here (they
 * live in the Facility Limits tab). No outer card/collapsible chrome —
 * the tab panel is the container.
 */
export function AicPlanContent({
  groups,
  layers,
  nodes,
  researched,
  isAtDefaultsByGroup,
  onToggleNode,
  onActivateLayer,
  onActivateGroup,
  onResetGroup,
  changedNodes,
  readOnly = false,
}: AicPlanContentProps) {
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <AicPlanGroup
          key={group.id}
          group={group}
          layers={layers}
          nodes={nodes}
          researched={researched}
          isAtDefaults={isAtDefaultsByGroup.get(group.id) ?? false}
          onToggleNode={onToggleNode}
          onActivateLayer={onActivateLayer}
          onActivateGroup={onActivateGroup}
          onResetGroup={onResetGroup}
          changedNodes={changedNodes}
          readOnly={readOnly}
        />
      ))}
    </div>
  );
}

interface AicPlanGroupProps {
  group: AicGroup;
  layers: readonly AicLayer[];
  nodes: readonly AicNode[];
  researched: ReadonlySet<AicTechId>;
  isAtDefaults: boolean;
  onToggleNode: (id: AicTechId) => void;
  onActivateLayer: (layerId: string) => void;
  onActivateGroup: (groupId: AicGroupId) => void;
  onResetGroup: (groupId: AicGroupId) => void;
  changedNodes?: ReadonlySet<AicTechId>;
  /** Freezes the group's edit actions while leaving expand/collapse
   *  navigation usable — see `AicPlanContentProps.readOnly`. */
  readOnly?: boolean;
}

function AicPlanGroup({
  group,
  layers,
  nodes,
  researched,
  isAtDefaults,
  onToggleNode,
  onActivateLayer,
  onActivateGroup,
  onResetGroup,
  changedNodes,
  readOnly = false,
}: AicPlanGroupProps) {
  const { t } = useTranslation(["aic", "settings"]);

  const groupLayers = useMemo(
    () => layers.filter((l) => l.groupId === group.id),
    [layers, group.id],
  );

  const { nodesByLayer, researchableCount, researchedCount } = useMemo(() => {
    const byLayer = new Map<string, AicNode[]>();
    let total = 0;
    let done = 0;
    for (const node of nodes) {
      if (node.groupId !== group.id) continue;
      if (node.action.kind === "capRaise") continue;
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
      researchableCount: total,
      researchedCount: done,
    };
  }, [nodes, researched, group.id]);

  const groupName = t(`groups.${group.id}.name`, {
    ns: "aic",
    defaultValue: group.id,
  });
  const allDone = researchedCount === researchableCount;

  // Layers render only when they have ≥1 researchable (non-capRaise) node;
  // those are the ones the expand/collapse-all toggle drives.
  const visibleLayerIds = useMemo(
    () =>
      groupLayers
        .filter((l) => (nodesByLayer.get(l.id)?.length ?? 0) > 0)
        .map((l) => l.id),
    [groupLayers, nodesByLayer],
  );

  // Controlled layer-expand state, owned here so one toggle can drive every
  // layer at once. Starts all-collapsed; resets to collapsed on region
  // switch (this group remounts when its id changes).
  const [openLayers, setOpenLayers] = useState<ReadonlySet<AicLayerId>>(
    () => new Set<AicLayerId>(),
  );
  const allLayersOpen =
    visibleLayerIds.length > 0 &&
    visibleLayerIds.every((id) => openLayers.has(id));

  const handleLayerOpenChange = (layerId: AicLayerId, open: boolean) => {
    setOpenLayers((prev) => {
      const next = new Set(prev);
      if (open) next.add(layerId);
      else next.delete(layerId);
      return next;
    });
  };
  const toggleAllLayers = () => {
    setOpenLayers(allLayersOpen ? new Set() : new Set(visibleLayerIds));
  };

  // Auto-expand the layers holding the flashed techs when this group's
  // region is the focus target, so the (Radix-unmounted) collapsed rows
  // mount and can flash + scroll into view.
  const focus = useSettingsFocus();
  useEffect(() => {
    if (!focus || focus.domainId !== group.domainId) return;
    const techSet = new Set(focus.techIds);
    const toOpen: AicLayerId[] = [];
    for (const layer of groupLayers) {
      if (nodesByLayer.get(layer.id)?.some((n) => techSet.has(n.id))) {
        toOpen.push(layer.id);
      }
    }
    if (toOpen.length > 0) {
      setOpenLayers((prev) => new Set([...prev, ...toOpen]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-sm font-semibold flex-1 min-w-0 truncate">
          {groupName}
        </span>
        <span
          className={cn(
            "text-[11px] tabular-nums font-medium rounded px-1.5 py-0.5 shrink-0",
            allDone
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          {researchedCount}/{researchableCount}
        </span>
        {visibleLayerIds.length >= 2 && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-9 sm:size-7 text-muted-foreground hover:text-foreground hover:bg-accent/80 shrink-0"
            onClick={toggleAllLayers}
            aria-label={
              allLayersOpen
                ? t("aic.collapseAll", {
                    ns: "settings",
                    defaultValue: "Collapse all",
                  })
                : t("aic.expandAll", {
                    ns: "settings",
                    defaultValue: "Expand all",
                  })
            }
            title={
              allLayersOpen
                ? t("aic.collapseAll", {
                    ns: "settings",
                    defaultValue: "Collapse all",
                  })
                : t("aic.expandAll", {
                    ns: "settings",
                    defaultValue: "Expand all",
                  })
            }
          >
            {allLayersOpen ? (
              <ChevronsDownUp className="size-4" />
            ) : (
              <ChevronsUpDown className="size-4" />
            )}
          </Button>
        )}
        {!allDone && !readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-9 sm:size-7 text-muted-foreground hover:text-foreground hover:bg-accent/80 shrink-0"
            onClick={() => onActivateGroup(group.id)}
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
        {!isAtDefaults && !readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-9 sm:size-7 text-muted-foreground hover:text-foreground hover:bg-accent/80 shrink-0"
            onClick={() => onResetGroup(group.id)}
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
      <AicLayerList
        layers={groupLayers}
        nodesByLayer={nodesByLayer}
        researched={researched}
        openLayers={openLayers}
        onLayerOpenChange={handleLayerOpenChange}
        onToggleNode={onToggleNode}
        onActivateLayer={onActivateLayer}
        changedNodes={changedNodes}
      />
    </div>
  );
}
