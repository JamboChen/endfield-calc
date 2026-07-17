import { useCallback } from "react";
import { Handle, Position, useReactFlow } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Wind } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { FacilityIcon } from "@/components/FacilityIcon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ItemIcon } from "../production/recipe-cells";
import {
  getItemName,
  getFacilityName,
  getRecipeName,
  getTransportLabel,
} from "@/lib/i18n-helpers";
import { useTranslation } from "react-i18next";
import type { EnvSinkNodeData } from "@/types";
import {
  getTransportCountWithFacilities,
  formatCount,
  formatNumber,
} from "@/lib/utils";
import { nodeRingClasses } from "@/components/flow/flow-utils";

/**
 * CustomEnvNode renders a gas-environment sink: a Gas Dispersing Unit
 * (1.4 vaporizer) burning gas to project a Gaseous Environment aura.
 * Mirrors CustomDisposalNode / CustomPowerNode structurally (all three
 * are consumer sinks) with a teal theme + Wind icon.
 *
 * The card keeps the consumed-gas headline (sink-family consistency) but
 * names the BUFF via the vaporize recipe's localized name ("Gaseous
 * Environment (Inergen)") and lists the buffed machines by FORMULA — the
 * env buff attaches to the recipe, not the facility, so a Forge of the
 * Sky running plain Xiranite Powder is NOT in the aura while one running
 * the env-gated Xiranite Powder β is. In Facility View this node is one
 * of several (one per vaporizer building), each listing its own
 * representative slice of the buffed machines.
 */
export default function CustomEnvNode({
  data,
  targetPosition = Position.Left,
  selected,
}: NodeProps<Node<EnvSinkNodeData>>) {
  const {
    item,
    intakeRate,
    facility,
    facilityCount,
    vaporizeRecipeId,
    covered,
    coveredBuildings,
    ceilMode,
  } = data;
  const { t } = useTranslation("production");
  const itemName = getItemName(item);
  const facilityName = getFacilityName(facility);
  const buffName = getRecipeName(vaporizeRecipeId);

  // Click-to-jump to a specific buffed building node (Facility View):
  // center + select it, mirroring the graph search panel's jump. The
  // selection change pins the spotlight via `onSelectionChange`.
  const rf = useReactFlow();
  const jumpToBuilding = useCallback(
    (targetId: string) => {
      const n = rf.getNode(targetId);
      if (!n) return;
      const w = n.measured?.width ?? n.width ?? 208;
      const h = n.measured?.height ?? n.height ?? 125;
      rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, {
        zoom: Math.max(rf.getZoom(), 0.8),
        duration: 400,
      });
      rf.setNodes((nds) =>
        nds.map((x) =>
          x.selected !== (x.id === targetId)
            ? { ...x, selected: x.id === targetId }
            : x,
        ),
      );
    },
    [rf],
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Card
          className={`
            w-56 shadow-xl
            border-2 border-teal-600 dark:border-teal-500
            bg-teal-50/40 dark:bg-teal-950/20
            hover:shadow-2xl transition-all cursor-help relative
            ${nodeRingClasses(selected, data.pinConsumer)}
          `}
        >
          <Handle
            type="target"
            position={targetPosition}
            isConnectable={false}
            className="bg-teal-500!"
          />
          <CardContent className="p-0 text-xs">
            {/* === Zone 1: Teal header strip (gas headline) === */}
            <div className="bg-teal-100/70 dark:bg-teal-900/40 rounded-t-sm px-2.5 py-2">
              <div className="flex items-center gap-2">
                <ItemIcon item={item} />
                <div className="flex-1 min-w-0">
                  <div className="font-bold truncate leading-tight">{itemName}</div>
                  <span className="text-[9px] text-teal-700 dark:text-teal-300 font-semibold uppercase tracking-wide">
                    {t("tree.gasEnv")}
                  </span>
                </div>
                <div className="h-6 w-6 rounded-sm bg-teal-500 dark:bg-teal-600 flex items-center justify-center shrink-0">
                  <Wind className="h-3.5 w-3.5 text-white" />
                </div>
              </div>
            </div>

            {/* === Zone 2: Intake rate (centered) === */}
            <div className="flex flex-col items-center py-2 px-2.5">
              <div className="flex items-baseline gap-1">
                <span className="font-mono font-semibold text-teal-700 dark:text-teal-400 text-sm">
                  {formatNumber(intakeRate)}
                </span>
                <span className="text-[11px] text-teal-700/70 dark:text-teal-400/70">/min</span>
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {formatCount(getTransportCountWithFacilities(intakeRate, item, ceilMode, facilityCount), ceilMode)} {getTransportLabel(item)}
              </span>
            </div>

            {/* === Zone 3: Buff name (what environment this creates) === */}
            <div className="mx-2.5 mb-2 bg-teal-100/50 dark:bg-teal-900/30 border border-teal-200/50 dark:border-teal-800/50 rounded-sm px-2 py-1">
              <div className="text-[9px] text-teal-700/70 dark:text-teal-300/70 font-semibold uppercase tracking-wide leading-tight">
                {t("tree.gasEnvCreates")}
              </div>
              <div className="text-[11px] font-medium truncate leading-tight">
                {buffName}
              </div>
            </div>

            {/* === Zone 4: Buffed machines === */}
            {/* Facility View: one row PER buffed building, named
                `<facility> i/N` and linkable to that building node.
                Recipe View / merged: aggregate by (facility, formula). */}
            {coveredBuildings.length > 0 ? (
              <div className="mx-2.5 mb-2">
                <div className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wide mb-0.5">
                  {t("tree.gasEnvBuffs")}
                </div>
                <ul className="space-y-0.5">
                  {coveredBuildings.map((b, i) => {
                    const label = `${getFacilityName(b.facility)} ${b.index + 1}/${b.total}`;
                    const row = (
                      <>
                        <FacilityIcon
                          facility={b.facility}
                          alt={getFacilityName(b.facility)}
                          className="h-3.5 w-3.5 object-contain shrink-0"
                        />
                        <span className="text-[10px] truncate flex-1 min-w-0 text-left">
                          {getFacilityName(b.facility)}
                        </span>
                        <span className="font-mono text-[10px] shrink-0">
                          {b.index + 1}/{b.total}
                        </span>
                      </>
                    );
                    return (
                      <li key={`${b.nodeId ?? label}-${i}`}>
                        {b.nodeId ? (
                          <button
                            type="button"
                            title={label}
                            onClick={(e) => {
                              e.stopPropagation();
                              jumpToBuilding(b.nodeId!);
                            }}
                            className="nodrag nopan flex items-center gap-1.5 min-w-0 w-full rounded-sm px-0.5 hover:bg-teal-100/60 dark:hover:bg-teal-900/40 cursor-pointer text-teal-800 dark:text-teal-200"
                          >
                            {row}
                          </button>
                        ) : (
                          <div
                            title={label}
                            className="flex items-center gap-1.5 min-w-0 px-0.5"
                          >
                            {row}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : covered.length > 0 ? (
              <div className="mx-2.5 mb-2">
                <div className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wide mb-0.5">
                  {t("tree.gasEnvBuffs")}
                </div>
                <ul className="space-y-0.5">
                  {covered.map((c) => (
                    <li
                      key={`${c.facility.id}-${c.recipe.id}`}
                      className="flex items-center gap-1.5 min-w-0"
                    >
                      <FacilityIcon
                        facility={c.facility}
                        alt={getFacilityName(c.facility)}
                        className="h-3.5 w-3.5 object-contain shrink-0"
                      />
                      <span className="text-[10px] truncate flex-1 min-w-0">
                        {getRecipeName(c.recipe)}
                      </span>
                      <span className="font-mono text-[10px] shrink-0">
                        ×{c.buildings}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* === Zone 5: Facility === */}
            <div className="flex items-center justify-between mx-2.5 mb-2.5 bg-blue-100/50 dark:bg-blue-900/30 border border-blue-200/50 dark:border-blue-800/50 rounded-sm px-2 py-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <FacilityIcon
                  facility={facility}
                  alt={facilityName}
                  className="h-4 w-4 object-contain shrink-0 text-blue-600 dark:text-blue-400"
                />
                <span className="text-[10px] text-muted-foreground truncate">
                  {facilityName}
                </span>
              </div>
              <span className="font-mono font-semibold text-xs shrink-0 ml-2">
                ×{formatCount(facilityCount, ceilMode)}
              </span>
            </div>
          </CardContent>
        </Card>
      </TooltipTrigger>

      {/* Tooltip content */}
      <TooltipContent side="right" className="p-0 border shadow-md">
        <div className="text-xs max-w-[320px] p-2 max-h-[80vh] overflow-y-auto">
          <div className="font-bold mb-1">{buffName}</div>
          <div className="text-muted-foreground mb-2">
            {t("tree.gasEnvDescription", {
              item: itemName,
              rate: formatNumber(intakeRate),
            })}
          </div>
          {coveredBuildings.length > 0 ? (
            <div className="mt-2 pt-2 border-t">
              <div className="text-muted-foreground mb-1">
                {t("tree.gasEnvBuffsDetail")}
              </div>
              <ul className="space-y-0.5">
                {coveredBuildings.map((b, i) => (
                  <li key={`tt-${b.nodeId ?? b.facility.id}-${i}`}>
                    <span className="font-medium">
                      {getFacilityName(b.facility)}
                    </span>{" "}
                    <span className="text-muted-foreground font-mono">
                      {b.index + 1}/{b.total}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : covered.length > 0 ? (
            <div className="mt-2 pt-2 border-t">
              <div className="text-muted-foreground mb-1">
                {t("tree.gasEnvBuffsDetail")}
              </div>
              <ul className="space-y-0.5">
                {covered.map((c) => (
                  <li key={`tt-${c.facility.id}-${c.recipe.id}`}>
                    <span className="font-medium">
                      {getFacilityName(c.facility)}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      · {getRecipeName(c.recipe)} ×{c.buildings}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-2 pt-2 border-t">
            <div className="text-muted-foreground">
              {t("tree.facility")}: {facilityName}
            </div>
            <div className="text-muted-foreground">
              {t("tree.facilityCount")}: {formatCount(facilityCount, ceilMode)}
            </div>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
