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
import { getItemName, getFacilityName } from "@/lib/i18n-helpers";
import { useTranslation } from "react-i18next";
import type { TargetSinkNodeData } from "@/types";
import { getBeltCount } from "@/lib/utils";

/**
 * Formats a number to a fixed number of decimal places.
 */
const formatNumber = (num: number, decimals = 2): string => {
  return num.toFixed(decimals);
};

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
  const { item, targetRate, productionInfo, ceilMode = false } = data;
  const { t } = useTranslation("production");
  const itemName = getItemName(item);
  const { items } = data;

  const getItemById = (itemId: string) => items.find((i) => i.id === itemId);

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
          <CardContent className="p-2.5 text-xs">
            {/* Target indicator and item info */}
            <div className="flex items-center gap-2 mb-2">
              <div className="h-5 w-5 rounded-sm bg-amber-500 dark:bg-amber-600 flex items-center justify-center">
                <Target className="h-3 w-3 text-white" />
              </div>
              <ItemIcon item={item} />
              <span className="font-bold truncate flex-1">{itemName}</span>
            </div>
            {/* Target label */}
            <div className="text-center mb-2 px-2 py-0.5 bg-amber-100/70 dark:bg-amber-900/40 border border-amber-200/50 dark:border-amber-800/50 rounded-sm">
              <span className="text-[10px] text-amber-700 dark:text-amber-300 font-semibold uppercase tracking-wide">
                {t("tree.target")}
              </span>
            </div>
            {/* Target rate */}
            <div className="flex items-center justify-between bg-card border border-border/50 rounded-sm px-2 py-1 mb-2">
              <span className="text-muted-foreground text-[10px]">
                {t("tree.targetRate")}
              </span>
              <div className="flex flex-col items-end">
                <span className="font-mono font-semibold text-amber-700 dark:text-amber-400 text-xs">
                  {formatNumber(targetRate)} /min
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {formatNumber(getBeltCount(targetRate, ceilMode as boolean), ceilMode ? 0 : 1)} {t("belt.belts")}
                </span>
              </div>
            </div>
            {/* Production info for terminal targets */}
            {isTerminalTarget && facility && (
              <div className="flex items-center justify-between bg-blue-100/50 dark:bg-blue-900/30 border border-blue-200/50 dark:border-blue-800/50 rounded-sm px-2 py-1">
                <div className="flex items-center gap-1.5">
                  {facility.iconUrl ? (
                    <img
                      src={facility.iconUrl}
                      alt={facilityName}
                      className="h-4 w-4 object-contain"
                    />
                  ) : (
                    <Factory className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  )}
                  <span className="text-[10px] text-muted-foreground truncate max-w-20">
                    {facilityName}
                  </span>
                </div>
                <span className="font-mono font-semibold text-blue-700 dark:text-blue-300 text-xs">
                  ×{formatNumber(productionInfo.facilityCount, 1)}
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
                getItemById={getItemById}
              />
              <div className="mt-2 pt-2 border-t">
                <div className="text-muted-foreground">
                  {t("tree.facility")}: {facilityName}
                </div>
                <div className="text-muted-foreground">
                  {t("tree.facilityCount")}:{" "}
                  {formatNumber(productionInfo.facilityCount, 1)}
                </div>
                <div className="text-muted-foreground">
                  {t("tree.power")}:{" "}
                  {formatNumber(
                    facility.powerConsumption * productionInfo.facilityCount,
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
