import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  type NodeTypes,
  type Node,
  type OnSelectionChangeFunc,
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
  Recipe,
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
import {
  getNeighborhood,
  getPinnedSpotlight,
  mergeSpotlights,
} from "@/lib/flow-spotlight";
import { mapPlanToFlowMerged } from "../mappers/merged-mapper";
import {
  mapPlanToFlowBinFused,
  mapPlanToFlowBinFusedSeparated,
} from "../mappers/bin-fused-mapper";
import { applyEdgeStyling } from "./flow-utils";
import CustomBackwardEdge from "../nodes/CustomBackwardEdge";
import CustomBezierEdge from "../nodes/CustomBezierEdge";
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

type ProductionDependencyTreeProps = {
  plan: ProductionDependencyGraph | null;
  items: Item[];
  /**
   * Available recipes — chain-filtered set from App.tsx. Used by the
   * bin-fused merged mapper to look up bin-constituent recipe objects
   * for headline / sister metadata. Safe to narrow: the calc only
   * emitted plans containing recipes from this set.
   */
  recipes: readonly Recipe[];
  facilities: Facility[];
  visualizationMode?: VisualizationMode;
  targetRates?: Map<ItemId, number>;
  twoEndAlignment?: boolean;
  ceilMode?: boolean;
  /**
   * When true (default), the merged Recipe View fuses each multi-formula
   * bin into a single building card. When false, falls back to the
   * per-recipe layout (one card per recipe). Has no effect on Facility
   * View, which is always bin-fused.
   */
  binFusion?: boolean;
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
  recipes,
  facilities,
  visualizationMode = "separated",
  targetRates,
  twoEndAlignment = false,
  ceilMode = false,
  binFusion = true,
}: ProductionDependencyTreeProps) {
  const { t } = useTranslation("production");
  const containerRef = useRef<HTMLDivElement>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowProductionNode>(
    [],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Spotlight state. Hover = direct neighborhood (the "which belts does
  // this building connect to" wiring task); click-to-pin (React Flow
  // selection) = upstream production cone + direct consumers (the
  // "what do I build to run this, and where does its output go" task)
  // — pinning survives pan/zoom, hover cannot. Hover stays active while
  // pinned: the hovered neighborhood lights up ON TOP of the pinned set.
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [pinnedNodeIds, setPinnedNodeIds] = useState<string[]>([]);

  useEffect(() => {
    let isMounted = true;
    async function computeLayout() {
      // Stale spotlight ids must not survive a plan/mode change.
      setHoveredNodeId(null);
      setPinnedNodeIds([]);
      if (!plan || plan.nodes.size === 0) {
        setNodes([]);
        setEdges([]);
        return;
      }

      // Select mapper:
      //   - Facility View (separated) is ALWAYS bin-fused per the
      //     documented invariant; the Recipe-View toggle has no UI
      //     affordance in this mode and must not leak through when the
      //     user persisted bf=0 in the URL hash.
      //   - Recipe View (merged) with binFusion ON (default): one card
      //     per bin via the bin-fused merged mapper.
      //   - Recipe View (merged) with binFusion OFF: per-recipe via
      //     the original merged mapper (chain-debugging mode).
      const flowData =
        visualizationMode === "separated"
          ? mapPlanToFlowBinFusedSeparated(
              plan,
              items,
              recipes,
              facilities,
              targetRates,
              ceilMode,
            )
          : binFusion
            ? mapPlanToFlowBinFused(plan, items, recipes, facilities, targetRates, ceilMode)
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
  }, [plan, items, recipes, facilities, visualizationMode, targetRates, twoEndAlignment, ceilMode, binFusion, setNodes, setEdges]);

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

  // Active spotlight: pinned set (upstream cone + direct consumers),
  // hovered neighborhood, or — when both are active — their union, so
  // hovering keeps working while a pin is held.
  const spotlight = useMemo(() => {
    const pinned =
      pinnedNodeIds.length > 0
        ? getPinnedSpotlight(edges, pinnedNodeIds)
        : null;
    const hovered = hoveredNodeId
      ? getNeighborhood(edges, hoveredNodeId)
      : null;
    if (pinned && hovered) return mergeSpotlights(pinned, hovered);
    return pinned ?? hovered;
  }, [edges, hoveredNodeId, pinnedNodeIds]);

  // Derived display arrays. With no spotlight these are the state arrays
  // themselves (zero overhead); with a spotlight, out-of-set elements get
  // a dim marker (className for nodes, data flag for edges — edge labels
  // live in a separate HTML layer that CSS classes can't reach).
  const displayNodes = useMemo(() => {
    if (!spotlight) return nodes;
    return nodes.map((node) =>
      spotlight.nodeIds.has(node.id)
        ? node
        : ({ ...node, className: "spotlight-dim" } as typeof node),
    );
  }, [nodes, spotlight]);

  const displayEdges = useMemo(() => {
    if (!spotlight) return edges;
    return edges.map((edge) =>
      spotlight.edgeIds.has(edge.id)
        ? edge
        : { ...edge, data: { ...edge.data, dimmed: true } },
    );
  }, [edges, spotlight]);

  const onNodeMouseEnter = useCallback(
    (_event: React.MouseEvent, node: Node) => setHoveredNodeId(node.id),
    [],
  );
  const onNodeMouseLeave = useCallback(() => setHoveredNodeId(null), []);

  // Pin = React Flow node selection: click to pin, click canvas to clear,
  // shift-click / box-select to pin a union of spotlights.
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes }) =>
      setPinnedNodeIds(selectedNodes.map((node) => node.id)),
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
          nodes={displayNodes}
          edges={displayEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onSelectionChange={onSelectionChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{
            padding: 0.2,
            minZoom: 0.1,
            maxZoom: 1.5,
          }}
          // Without this, the Controls fit-view button bottoms out at the
          // default minZoom (0.5) and cannot actually fit large graphs.
          minZoom={0.1}
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
          {/* Colours come from --xy-minimap-* vars in index.css so they
              flip with the theme (props would freeze them). */}
          <MiniMap pannable zoomable />
          <ExportImageButton containerRef={containerRef} />
        </ReactFlow>
      </div>
    </div>
  );
}
