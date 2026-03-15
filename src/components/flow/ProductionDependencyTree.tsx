import { useMemo, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  type NodeTypes,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Edge,
  Panel,
  useReactFlow,
  getNodesBounds,
  getViewportForBounds,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toPng, toSvg } from "html-to-image";
import type {
  Item,
  ItemId,
  Facility,
  FlowProductionNode,
  VisualizationMode,
  ProductionDependencyGraph,
} from "@/types";
import CustomProductionNode from "../nodes/CustomProductionNode";
import CustomTargetNode from "../nodes/CustomTargetNode";
import CustomDisposalNode from "../nodes/CustomDisposalNode";
import { useTranslation } from "react-i18next";
import { getLayoutedElements } from "@/lib/layout";
import { mapPlanToFlowMerged } from "../mappers/merged-mapper";
import { mapPlanToFlowSeparated } from "../mappers/separated-mapper";
import { applyEdgeStyling } from "./flow-utils";
import CustomBackwardEdge from "../nodes/CustomBackwardEdge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Download } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const EXPORT_FORMATS = ["svg", "png"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

function isExportFormat(v: string): v is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(v);
}

const CONTENT_PADDING = 0.1; // 10% padding around nodes

function ExportImageButton({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation("production");
  const { getNodes } = useReactFlow();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("svg");
  const [scale, setScale] = useState(2);

  const handleExport = () => {
    const viewport = containerRef.current?.querySelector(
      ".react-flow__viewport",
    ) as HTMLElement | null;
    if (!viewport) return;

    const nodes = getNodes();
    if (nodes.length === 0) return;

    const nodesBounds = getNodesBounds(nodes);

    // Base export size matches the actual content bounds (no distortion)
    const baseWidth = Math.ceil(nodesBounds.width);
    const baseHeight = Math.ceil(nodesBounds.height + 100); // add extra height to accommodate edge labels outside node bounds
    const exportWidth = format === "png" ? baseWidth * scale : baseWidth;
    const exportHeight = format === "png" ? baseHeight * scale : baseHeight;


    const { x, y, zoom } = getViewportForBounds(
      nodesBounds,
      exportWidth,
      exportHeight,
      0.01,
      10,
      CONTENT_PADDING,
    );

    // Resolve the actual theme background colour (avoids transparent/partial-white issues)
    const bgColor = getComputedStyle(document.body).backgroundColor;

    const options = {
      backgroundColor: bgColor,
      width: exportWidth,
      height: exportHeight,
      style: {
        width: `${exportWidth}px`,
        height: `${exportHeight}px`,
        transform: `translate(${x}px, ${y}px) scale(${zoom})`,
      },
    };

    const exportFn = format === "svg" ? toSvg : toPng;
    const filename =
      format === "svg" ? "production-graph.svg" : "production-graph.png";

    exportFn(viewport, options)
      .then((dataUrl) => {
        const a = document.createElement("a");
        a.download = filename;
        a.href = dataUrl;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setDialogOpen(false);
      })
      .catch(() => {
        // ignore export errors
      });
  };

  return (
    <>
      <Panel position="top-right">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(true)}
              className="h-8 w-8 p-0 bg-card border-border shadow-sm"
              aria-label={t("tree.exportImage")}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("tree.exportImage")}</TooltipContent>
        </Tooltip>
      </Panel>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("tree.exportImage")}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <Label>{t("tree.exportFormat")}</Label>
              <ToggleGroup
                type="single"
                value={format}
                onValueChange={(v) => {
                  if (v && isExportFormat(v)) setFormat(v);
                }}
                className="justify-start"
              >
                <ToggleGroupItem value="svg">SVG</ToggleGroupItem>
                <ToggleGroupItem value="png">PNG</ToggleGroupItem>
              </ToggleGroup>
            </div>

            {format === "png" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="export-scale">{t("tree.exportScale")}</Label>
                <Input
                  id="export-scale"
                  type="number"
                  min={1}
                  max={10}
                  step={0.5}
                  value={scale}
                  onChange={(e) => {
                    const val = e.target.valueAsNumber;
                    setScale(isNaN(val) || val < 1 ? 1 : val);
                  }}
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button onClick={handleExport}>{t("tree.exportConfirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

import CustomBezierEdge from "../nodes/CustomBezierEdge";

type ProductionDependencyTreeProps = {
  plan: ProductionDependencyGraph | null;
  items: Item[];
  facilities: Facility[];
  visualizationMode?: VisualizationMode;
  targetRates?: Map<ItemId, number>;
  twoEndAlignment?: boolean;
  ceilMode?: boolean;
};

/**
 * ProductionDependencyTree component displays a React Flow graph of production dependencies.
 *
 * It supports two visualization modes:
 * - Merged: Combines identical production steps and shows aggregated facility counts
 * - Separated: Shows each individual facility as a separate node for detailed planning
 *
 * The component automatically layouts nodes using the Dagre algorithm and applies
 * dynamic styling to edges based on material flow rates and geometry.
 *
 * @param {ProductionDependencyTreeProps} props The component props
 * @returns A React Flow component displaying the production dependency tree
 */
export default function ProductionDependencyTree({
  plan,
  items,
  facilities,
  visualizationMode = "separated",
  targetRates,
  twoEndAlignment = false,
  ceilMode = false,
}: ProductionDependencyTreeProps) {
  const { t } = useTranslation("production");
  const containerRef = useRef<HTMLDivElement>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowProductionNode>(
    [],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    let isMounted = true;
    async function computeLayout() {
      if (!plan || plan.nodes.size === 0) {
        setNodes([]);
        setEdges([]);
        return;
      }

      // Select mapper - now passes DAG structure instead of tree
      const flowData =
        visualizationMode === "separated"
          ? mapPlanToFlowSeparated(plan, items, facilities, targetRates, ceilMode)
          : mapPlanToFlowMerged(plan, items, facilities, targetRates, ceilMode);

      const { nodes: layoutedNodes, edges: layoutedEdges } =
        await getLayoutedElements(
          flowData.nodes,
          flowData.edges,
          "RIGHT",
          twoEndAlignment,
        );

      if (!isMounted) return;

      const styledEdges = applyEdgeStyling(layoutedEdges, layoutedNodes);

      setNodes(layoutedNodes as FlowProductionNode[]);
      setEdges(styledEdges);
    }

    computeLayout();

    return () => {
      isMounted = false;
    };
  }, [plan, items, facilities, visualizationMode, targetRates, twoEndAlignment, ceilMode, setNodes, setEdges]);

  const nodeTypes: NodeTypes = useMemo(
    () => ({
      productionNode: CustomProductionNode,
      targetSink: CustomTargetNode,
      disposalSink: CustomDisposalNode,
    }),
    [],
  );

  const edgeTypes = useMemo(
    () => ({
      simplebezier: CustomBezierEdge,
      backwardEdge: CustomBackwardEdge,
    }),
    [],
  );

  if (!plan || plan.nodes.size === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center text-muted-foreground">
        {t("tree.noTarget")}
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex-1" ref={containerRef}>
        <ReactFlow
          className="flow-theme"
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{
            padding: 0.2,
            minZoom: 0.1,
            maxZoom: 1.5,
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
          <Controls
            className="flow-controls"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              boxShadow: "0 1px 2px oklch(0 0 0 / 0.12)",
              overflow: "hidden",
            }}
          />
          <ExportImageButton containerRef={containerRef} />
        </ReactFlow>
      </div>
    </div>
  );
}
