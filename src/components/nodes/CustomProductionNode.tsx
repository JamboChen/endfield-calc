import { Handle, type NodeProps, type Node, Position } from "@xyflow/react";
import { Card, CardContent } from "@/components/ui/card";
import { Factory, Zap, Star, ArrowDownToLine } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RecipeIOFull, ItemIcon } from "../production/ProductionTable";
import { getItemName, getFacilityName } from "@/lib/i18n-helpers";
import { useTranslation } from "react-i18next";
import type {
  FlowNodeData,
  FlowNodeDataSeparated,
  FlowNodeDataSeparatedWithTarget,
  FlowNodeDataWithTarget,
} from "@/types";
import { getBeltCount, getPickupPointCount } from "@/lib/utils";

/**
 * Type alias for a React Flow node containing production data.
 * Can be either base FlowNodeData (merged mode) or FlowNodeDataSeparated (separated mode).
 */
export type FlowProductionNode = Node<FlowNodeData | FlowNodeDataSeparated>;

/**
 * Formats a number to a fixed number of decimal places.
 *
 * @param num The number to format
 * @param decimals The number of decimal places. Defaults to 2
 * @returns The formatted number as a string
 */
const formatNumber = (num: number, decimals = 2): string => {
  return num.toFixed(decimals);
};

/**
 * Type guard to check if node data is from separated mode.
 *
 * @param data The node data to check
 * @returns True if the data includes separated mode fields
 */
function isSeparatedMode(
  data: FlowNodeData | FlowNodeDataSeparated,
): data is FlowNodeDataSeparated {
  return "facilityIndex" in data && data.facilityIndex !== undefined;
}

function hasTargetInfo(
  data: FlowNodeData | FlowNodeDataSeparated,
): data is FlowNodeDataWithTarget | FlowNodeDataSeparatedWithTarget {
  return "isDirectTarget" in data && data.isDirectTarget === true;
}

/**
 * CustomProductionNode component renders a single production node in the dependency tree.
 *
 * The component adapts its display based on the visualization mode:
 * - Merged mode: Shows aggregated facility counts (e.g., "×2.5")
 * - Separated mode: Shows individual facility index (e.g., "1/3") and partial load status
 *
 * It displays item information, production rate, facility details, and highlights
 * circular dependencies and partial load conditions.
 *
 * @param {NodeProps<FlowProductionNode>} props The properties for the custom node
 * @returns A React component representing a production node
 */
export default function CustomProductionNode({
  data,
}: NodeProps<FlowProductionNode>) {
  const { productionNode: node, items, ceilMode = false } = data;
  const { t } = useTranslation("production");

  /**
   * Helper function to find an item by its ID from the provided items array.
   *
   * @param itemId The ID of the item to find
   * @returns The Item object or undefined if not found
   */
  const getItemById = (itemId: string) => items.find((i) => i.id === itemId);

  const itemName = getItemName(node.item);
  const facility = node.facility;
  const facilityName = facility ? getFacilityName(facility) : "";

  // Check if this is separated mode data
  const isSeparated = isSeparatedMode(data);
  const isTarget = hasTargetInfo(data);
  const targetRate = isTarget ? data.directTargetRate : undefined;

  // Adjust border colors based on node type for better visual distinction
  let borderClasses = "border-2";
  let bgClasses = "";

  if (node.isRawMaterial) {
    borderClasses += " border-green-600 dark:border-green-500";
    bgClasses = "bg-green-50 dark:bg-green-950/40";
  } else if (node.recipe) {
    borderClasses += " border-blue-600 dark:border-blue-500";
    bgClasses = "bg-blue-50/30 dark:bg-blue-950/20";
  } else {
    borderClasses += " border-border";
  }

  // Tooltip content for detailed node information
  const tooltipContent = (
    <div className="text-xs max-w-[300px] p-2 max-h-[80vh] overflow-y-auto">
      <div className="font-bold mb-1">
        {t("tree.item")}: {itemName}
      </div>
      {node.isRawMaterial ? (
        <div>
          <p className="text-muted-foreground">{t("tree.trueRawMaterial")}</p>
          <div className="mt-1 text-muted-foreground">
            {t("tree.pickupPoint")}: {isSeparated
              ? `${data.facilityIndex! + 1} / ${data.totalFacilities}`
              : `×${getPickupPointCount(node.targetRate)}`}
          </div>
        </div>
      ) : node.recipe ? (
        <>
          <RecipeIOFull recipe={node.recipe} getItemById={getItemById} />
          {facility && (
            <div className="mt-2 pt-2 border-t">
              <div className="text-muted-foreground">
                {t("tree.facility")}: {facilityName}
              </div>
              {isSeparated ? (
                // Separated mode: show individual facility info
                <>
                  <div className="text-muted-foreground">
                    {t("tree.facilityIndex")}: {data.facilityIndex! + 1} /{" "}
                    {data.totalFacilities}
                  </div>
                  <div className="text-muted-foreground">
                    {t("tree.power")}: {facility.powerConsumption}
                  </div>
                  {data.isPartialLoad && (
                    <div className="text-yellow-600 dark:text-yellow-400 text-xs mt-1">
                      ⚡ {t("tree.partialLoad")}
                    </div>
                  )}
                </>
              ) : (
                // Merged mode: show total power
                <div className="text-muted-foreground">
                  {t("tree.power")}: {facility.powerConsumption} ×{" "}
                  {formatNumber(node.facilityCount, 1)} ={" "}
                  {formatNumber(
                    facility.powerConsumption * node.facilityCount,
                    1,
                  )}
                </div>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Card
          className={`w-52 shadow-lg ${borderClasses} ${bgClasses} hover:shadow-xl transition-all cursor-help relative`}
        >
          <Handle
            type="target"
            position={Position.Left}
            id="left"
            isConnectable={false}
            className="w-3! h-3!"
          />
          <CardContent className="p-2.5 text-xs">
            {/* Item icon and name */}
            <div className="flex items-center gap-2 mb-2 relative">
              <ItemIcon item={node.item} />
              <span className="font-bold truncate flex-1">
                {itemName}
                {isSeparated && data.facilityIndex !== undefined && (
                  <span className="text-muted-foreground ml-1 text-[10px] font-normal">
                    #{data.facilityIndex + 1}
                  </span>
                )}
              </span>
              {/* Target badge */}
              {isTarget && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="absolute -top-1 -right-1 bg-amber-500 dark:bg-amber-600 text-white rounded-sm w-5 h-5 flex items-center justify-center shadow-sm">
                      <Star className="h-3 w-3 fill-current" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p className="text-xs">
                      {t("tree.alsoTarget")}: {formatNumber(targetRate!)} /min
                    </p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {/* Production/Requirement rate */}
            <div className="flex items-center justify-between mb-2 bg-muted/30 border border-border/50 rounded-sm px-2 py-1">
              <span className="text-muted-foreground text-[10px]">
                {node.isRawMaterial ? t("tree.required") : t("tree.produced")}
              </span>
              <div className="flex flex-col items-end">
                <span className="font-mono font-semibold text-xs">
                  {formatNumber(node.targetRate)} /min
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {formatNumber(getBeltCount(node.targetRate, ceilMode as boolean), ceilMode ? 0 : 1)} {t("belt.belts")}
                </span>
              </div>
            </div>
            {/* Facility details */}
            {!node.isRawMaterial && facility && (
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
                  {isSeparated
                    ? `${data.facilityIndex! + 1}/${data.totalFacilities}`
                    : `×${formatNumber(node.facilityCount, 1)}`}
                </span>
              </div>
            )}
            {/* Pickup point info bar (raw materials only) */}
            {node.isRawMaterial && (
              <div className="flex items-center justify-between bg-green-100/50 dark:bg-green-900/30 border border-green-200/50 dark:border-green-800/50 rounded-sm px-2 py-1">
                <div className="flex items-center gap-1.5">
                  <ArrowDownToLine className="h-4 w-4 text-green-600 dark:text-green-400" />
                  <span className="text-[10px] text-muted-foreground truncate max-w-20">
                    {t("tree.pickupPoint")}
                  </span>
                </div>
                <span className="font-mono font-semibold text-green-700 dark:text-green-300 text-xs">
                  {isSeparated
                    ? `${data.facilityIndex! + 1}/${data.totalFacilities}`
                    : `×${getPickupPointCount(node.targetRate)}`}
                </span>
              </div>
            )}
            {/* Partial load indicator (separated mode only) */}
            {isSeparated && data.isPartialLoad && (
              <div className="flex items-center justify-center gap-1 text-yellow-600 dark:text-yellow-400 font-medium text-[10px] mt-2 py-1 rounded-sm bg-yellow-100/50 dark:bg-yellow-900/20 border border-yellow-200/50 dark:border-yellow-800/50">
                <Zap className="h-3 w-3" />
                <span>{t("tree.partialLoad")}</span>
              </div>
            )}
          </CardContent>
          <Handle
            type="source"
            position={Position.Right}
            id="right"
            isConnectable={false}
            className="w-3! h-3!"
          />
        </Card>
      </TooltipTrigger>
      {/* Tooltip content with detailed information */}
      <TooltipContent side="right" className="p-0 border shadow-md">
        {tooltipContent}
      </TooltipContent>
    </Tooltip>
  );
}
