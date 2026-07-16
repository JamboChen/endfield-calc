import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Zap } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { FacilityIcon } from "@/components/FacilityIcon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ItemIcon } from "../production/recipe-cells";
import { getItemName, getFacilityName, getTransportLabel } from "@/lib/i18n-helpers";
import { useTranslation } from "react-i18next";
import type { PowerSinkNodeData } from "@/types";
import { getTransportCountWithFacilities, formatCount, formatNumber } from "@/lib/utils";
import { nodeRingClasses } from "@/components/flow/flow-utils";

/**
 * CustomPowerNode renders a power-generation sink: a Thermal Bank
 * consuming batteries to power the factory. Mirrors CustomDisposalNode
 * structurally (both are consumer sinks) with an amber theme + Zap
 * icon, and headlines the generated power instead of the burn rate.
 *
 * Generated power = `powerGeneration × facilityCount` with the
 * FRACTIONAL bank count in both view modes — generation is
 * fuel-supply-limited, so a ceiled idle bank adds nothing (matches
 * `BinAggregates.totalPowerGeneration`).
 */
export default function CustomPowerNode({
  data,
  targetPosition = Position.Left,
  selected,
}: NodeProps<Node<PowerSinkNodeData>>) {
  const { item, burnRate, facility, facilityCount, powerGeneration, ceilMode } =
    data;
  const { t } = useTranslation("production");
  const itemName = getItemName(item);
  const facilityName = getFacilityName(facility);
  const generatedPower = powerGeneration * facilityCount;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Card
          className={`
            w-52 shadow-xl
            border-2 border-amber-600 dark:border-amber-500
            bg-amber-50/40 dark:bg-amber-950/20
            hover:shadow-2xl transition-all cursor-help relative
            ${nodeRingClasses(selected, data.pinConsumer)}
          `}
        >
          <Handle
            type="target"
            position={targetPosition}
            isConnectable={false}
            className="bg-amber-500!"
          />
          <CardContent className="p-0 text-xs">
            {/* === Zone 1: Amber header strip === */}
            <div className="bg-amber-100/70 dark:bg-amber-900/40 rounded-t-sm px-2.5 py-2">
              <div className="flex items-center gap-2">
                <ItemIcon item={item} />
                <div className="flex-1 min-w-0">
                  <div className="font-bold truncate leading-tight">{itemName}</div>
                  <span className="text-[9px] text-amber-700 dark:text-amber-300 font-semibold uppercase tracking-wide">
                    {t("tree.powerGeneration")}
                  </span>
                </div>
                <div className="h-6 w-6 rounded-sm bg-amber-500 dark:bg-amber-600 flex items-center justify-center shrink-0">
                  <Zap className="h-3.5 w-3.5 text-white" />
                </div>
              </div>
            </div>

            {/* === Zone 2: Generated power + burn rate (centered) === */}
            <div className="flex flex-col items-center py-2.5 px-2.5">
              <div className="flex items-baseline gap-1">
                <span className="font-mono font-semibold text-amber-700 dark:text-amber-400 text-sm">
                  {formatNumber(generatedPower, 1)}
                </span>
                <span className="text-[11px] text-amber-700/70 dark:text-amber-400/70">
                  {t("tree.power")}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {formatNumber(burnRate)}/min ·{" "}
                {formatCount(getTransportCountWithFacilities(burnRate, item, ceilMode, facilityCount), ceilMode)}{" "}
                {getTransportLabel(item)}
              </span>
            </div>

            {/* === Zone 3: Facility === */}
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
        <div className="text-xs max-w-[300px] p-2 max-h-[80vh] overflow-y-auto">
          <div className="font-bold mb-1">{t("tree.powerTooltipTitle")}</div>
          <div className="text-muted-foreground mb-2">
            {t("tree.powerDescription", {
              item: itemName,
              rate: formatNumber(burnRate),
              power: formatNumber(generatedPower, 1),
            })}
          </div>
          <div className="mt-2 pt-2 border-t">
            <div className="text-muted-foreground">
              {t("tree.facility")}: {facilityName}
            </div>
            <div className="text-muted-foreground">
              {t("tree.facilityCount")}: {formatCount(facilityCount, ceilMode)}
            </div>
            <div className="text-muted-foreground">
              {t("tree.powerGeneration")}: {formatNumber(generatedPower, 1)}
            </div>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
