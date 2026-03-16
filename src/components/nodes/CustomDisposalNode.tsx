import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Trash2, Factory } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ItemIcon } from "../production/ProductionTable";
import { getItemName, getFacilityName, getTransportLabel } from "@/lib/i18n-helpers";
import { useTranslation } from "react-i18next";
import type { DisposalSinkNodeData } from "@/types";
import { getTransportCountWithFacilities, formatCount, getEffectiveFacilityCount, formatNumber } from "@/lib/utils";

/**
 * CustomDisposalNode renders a disposal sink node that consumes waste byproducts.
 * Visually similar to target sink nodes but with a red/rose theme to indicate waste disposal.
 */
export default function CustomDisposalNode({
  data,
  targetPosition = Position.Left,
}: NodeProps<Node<DisposalSinkNodeData>>) {
  const { item, disposalRate, facility, facilityCount, ceilMode } = data;
  const { t } = useTranslation("production");
  const itemName = getItemName(item);
  const facilityName = getFacilityName(facility);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Card
          className="
            w-52 shadow-xl
            border-2 border-rose-600 dark:border-rose-500
            bg-rose-50/40 dark:bg-rose-950/20
            hover:shadow-2xl transition-all cursor-help relative
          "
        >
          <Handle
            type="target"
            position={targetPosition}
            isConnectable={false}
            className="bg-rose-500!"
          />
          <CardContent className="p-0 text-xs">
            {/* === Zone 1: Rose header strip === */}
            <div className="bg-rose-100/70 dark:bg-rose-900/40 rounded-t-sm px-2.5 py-2">
              <div className="flex items-center gap-2">
                <ItemIcon item={item} />
                <div className="flex-1 min-w-0">
                  <div className="font-bold truncate leading-tight">{itemName}</div>
                  <span className="text-[9px] text-rose-700 dark:text-rose-300 font-semibold uppercase tracking-wide">
                    {t("tree.disposal")}
                  </span>
                </div>
                <div className="h-6 w-6 rounded-sm bg-rose-500 dark:bg-rose-600 flex items-center justify-center shrink-0">
                  <Trash2 className="h-3.5 w-3.5 text-white" />
                </div>
              </div>
            </div>

            {/* === Zone 2: Rate (centered) === */}
            <div className="flex flex-col items-center py-2.5 px-2.5">
              <div className="flex items-baseline gap-1">
                <span className="font-mono font-semibold text-rose-700 dark:text-rose-400 text-sm">
                  {formatNumber(disposalRate)}
                </span>
                <span className="text-[11px] text-rose-700/70 dark:text-rose-400/70">/min</span>
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {formatCount(getTransportCountWithFacilities(disposalRate, item, ceilMode, facilityCount), ceilMode)} {getTransportLabel(item)}
              </span>
            </div>

            {/* === Zone 3: Facility === */}
            <div className="flex items-center justify-between mx-2.5 mb-2.5 bg-blue-100/50 dark:bg-blue-900/30 border border-blue-200/50 dark:border-blue-800/50 rounded-sm px-2 py-1">
              <div className="flex items-center gap-1.5 min-w-0">
                {facility.iconUrl ? (
                  <img
                    src={facility.iconUrl}
                    alt={facilityName}
                    className="h-4 w-4 object-contain shrink-0"
                  />
                ) : (
                  <Factory className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
                )}
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
          <div className="font-bold mb-1">{t("tree.disposalTooltipTitle")}</div>
          <div className="text-muted-foreground mb-2">
            {t("tree.disposalDescription", {
              item: itemName,
              rate: formatNumber(disposalRate),
            })}
          </div>
          <div className="mt-2 pt-2 border-t">
            <div className="text-muted-foreground">
              {t("tree.facility")}: {facilityName}
            </div>
            <div className="text-muted-foreground">
              {t("tree.facilityCount")}:{" "}
              {formatCount(facilityCount, ceilMode)}
            </div>
            <div className="text-muted-foreground">
              {t("tree.power")}:{" "}
              {formatNumber(facility.powerConsumption * getEffectiveFacilityCount(facilityCount, ceilMode), 1)}
            </div>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
