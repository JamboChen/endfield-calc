import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Target, Factory } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RecipeIOFull, ItemIcon } from "../production/ProductionTable";
import { getItemName, getFacilityName, getTransportLabel } from "@/lib/i18n-helpers";
import { useTranslation } from "react-i18next";
import type { TargetSinkNodeData } from "@/types";
import { getTransportCount, formatCount, getEffectiveFacilityCount, formatNumber, getItemById } from "@/lib/utils";

/**
 * CustomTargetNode component renders a virtual sink node representing a user-defined production target.
 *
 * For terminal targets (targets without downstream consumers), it also displays production information
 * including facility count and recipe details.
 */
export default function CustomTargetNode({
  data,
  targetPosition = Position.Left,
}: NodeProps<Node<TargetSinkNodeData>>) {
  const { item, targetRate, productionInfo, ceilMode } = data;
  const { t } = useTranslation("production");
  const itemName = getItemName(item);

  // Check if this is a terminal target with production info
  const isTerminalTarget = productionInfo !== undefined;
  const facility = productionInfo?.facility;
  const facilityName = facility ? getFacilityName(facility) : "";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Card
          className="
            w-52 shadow-xl
            border-2 border-amber-600 dark:border-amber-500
            bg-amber-50/40 dark:bg-amber-950/20
            hover:shadow-2xl transition-all cursor-help relative
          "
        >
          {/* Target handle for incoming connections */}
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
                    {t("tree.target")}
                  </span>
                </div>
                <div className="h-6 w-6 rounded-sm bg-amber-500 dark:bg-amber-600 flex items-center justify-center shrink-0">
                  <Target className="h-3.5 w-3.5 text-white" />
                </div>
              </div>
            </div>

            {/* === Zone 2: Rate (centered) === */}
            <div className="flex flex-col items-center py-2.5 px-2.5">
              <div className="flex items-baseline gap-1">
                <span className="font-mono font-semibold text-amber-700 dark:text-amber-400 text-sm">
                  {formatNumber(targetRate)}
                </span>
                <span className="text-[11px] text-amber-700/70 dark:text-amber-400/70">/min</span>
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {formatCount(getTransportCount(targetRate, item, ceilMode), ceilMode)} {getTransportLabel(item)}
              </span>
            </div>

            {/* === Zone 3: Facility (terminal targets only) === */}
            {isTerminalTarget && facility && (
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
                <span className="font-mono font-semibold text-blue-700 dark:text-blue-300 text-xs shrink-0 ml-2">
                  ×{formatCount(productionInfo.facilityCount, ceilMode)}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </TooltipTrigger>

      {/* Tooltip content */}
      <TooltipContent side="right" className="p-0 border shadow-md">
        <div className="text-xs max-w-[300px] p-2 max-h-[80vh] overflow-y-auto">
          <div className="font-bold mb-1">{t("tree.productionTarget")}</div>
          <div className="text-muted-foreground mb-2">
            {t("tree.targetDescription", {
              item: itemName,
              rate: formatNumber(targetRate),
            })}
          </div>

          {/* Show production details for terminal targets */}
          {isTerminalTarget && facility && productionInfo.recipe && (
            <>
              <RecipeIOFull
                recipe={productionInfo.recipe}
                getItemById={(id) => getItemById(data.items, id)}
              />
              <div className="mt-2 pt-2 border-t">
                <div className="text-muted-foreground">
                  {t("tree.facility")}: {facilityName}
                </div>
                <div className="text-muted-foreground">
                  {t("tree.facilityCount")}:{" "}
                  {formatCount(productionInfo.facilityCount, ceilMode)}
                </div>
                <div className="text-muted-foreground">
                  {t("tree.power")}:{" "}
                  {formatNumber(
                    facility.powerConsumption * getEffectiveFacilityCount(productionInfo.facilityCount, ceilMode),
                    1,
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
