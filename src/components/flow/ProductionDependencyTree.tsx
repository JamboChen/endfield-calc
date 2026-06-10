import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  type NodeTypes,
  type Node,
  type OnSelectionChangeFunc,
  type ReactFlowInstance,
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
import { edgeBounds, computeEdgeFitView } from "@/lib/edge-fit";
import GraphSearchPanel from "./GraphSearchPanel";
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

/** Below this zoom, edge labels fade out (spotlit/hovered edges exempt). */
const LABEL_FADE_ZOOM = 0.5;

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
  // Hovered edge → emphasis (thicker stroke, label forced visible).
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  // Overview declutter: below this zoom, edge labels fade out (CSS class
  // toggled here — NOT a per-edge zoom subscription, which would re-render
  // every edge continuously while zooming).
  const [lowZoom, setLowZoom] = useState(false);
  const rfInstance = useRef<ReactFlowInstance<FlowProductionNode, Edge> | null>(
    null,
  );
  // Mode of the previous layout run. Formula View and Facility View
  // occupy wildly different extents (one card per bin vs one per
  // building), so a camera kept from the other mode can land in empty
  // space — re-fit on the switch. Deliberately ONLY for the
  // Formula/Facility switch: bin-fusion / alignment toggles and plan
  // recomputes preserve the camera. `null` = no layout yet (first
  // mount keeps the `fitView` prop behaviour).
  const lastLayoutModeRef = useRef<VisualizationMode | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function computeLayout() {
      // Stale spotlight ids must not survive a plan/mode change.
      setHoveredNodeId(null);
      setPinnedNodeIds([]);
      setHoveredEdgeId(null);
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

      // Re-center on a Formula ↔ Facility switch. Computed from the
      // in-hand layouted nodes (positions + dimensions set by
      // getLayoutedElements) instead of fitView() so there's no race
      // against the store receiving the new nodes. Limits/padding match
      // the fitViewOptions on the ReactFlow element.
      const modeChanged =
        lastLayoutModeRef.current !== null &&
        lastLayoutModeRef.current !== visualizationMode;
      lastLayoutModeRef.current = visualizationMode;
      if (modeChanged) {
        const pane = containerRef.current?.getBoundingClientRect();
        if (pane && rfInstance.current && layoutedNodes.length > 0) {
          const bounds = getNodesBounds(layoutedNodes);
          const viewport = getViewportForBounds(
            bounds,
            pane.width,
            pane.height,
            0.1,
            1.5,
            0.2,
          );
          rfInstance.current.setViewport(viewport, { duration: 300 });
        }
      }
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
  // live in a separate HTML layer that CSS classes can't reach), and the
  // pinned seeds' direct consumers get a data flag the node cards render
  // as an amber ring.
  const displayNodes = useMemo(() => {
    if (!spotlight) return nodes;
    return nodes.map((node) => {
      if (!spotlight.nodeIds.has(node.id)) {
        return { ...node, className: "spotlight-dim" } as typeof node;
      }
      if (spotlight.consumerNodeIds.has(node.id)) {
        return {
          ...node,
          data: { ...node.data, pinConsumer: true },
        } as typeof node;
      }
      return node;
    });
  }, [nodes, spotlight]);

  const displayEdges = useMemo(() => {
    if (!spotlight && !hoveredEdgeId) return edges;
    return edges.map((edge) => {
      const emphasis = edge.id === hoveredEdgeId;
      const lit = spotlight?.edgeIds.has(edge.id) ?? false;
      const dimmed = spotlight ? !lit : false;
      if (!emphasis && !lit && !dimmed) return edge;
      return {
        ...edge,
        // Raise the hovered edge above its siblings.
        zIndex: emphasis ? 1000 : edge.zIndex,
        data: { ...edge.data, dimmed, lit, emphasis },
      };
    });
  }, [edges, spotlight, hoveredEdgeId]);

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

  const onEdgeMouseEnter = useCallback(
    (_event: React.MouseEvent, edge: Edge) => setHoveredEdgeId(edge.id),
    [],
  );
  const onEdgeMouseLeave = useCallback(() => setHoveredEdgeId(null), []);

  // Click an edge → bring its WHOLE extent into view, but only when it
  // isn't already fully visible; the camera only pans/zooms OUT (capped
  // at the current zoom), never in. Edges are non-selecting (see
  // createEdge), so this never disturbs an active pin.
  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      const instance = rfInstance.current;
      const pane = containerRef.current?.getBoundingClientRect();
      if (!instance || !pane) return;
      const source = instance.getNode(edge.source);
      const target = instance.getNode(edge.target);
      if (!source || !target) return;

      const rect = (node: Node) => ({
        x: node.position.x,
        y: node.position.y,
        width: node.measured?.width ?? node.width ?? 208,
        height: node.measured?.height ?? node.height ?? 125,
      });
      const bounds = edgeBounds(
        rect(source),
        rect(target),
        edge.type === "backwardEdge",
      );
      const fit = computeEdgeFitView(bounds, instance.getViewport(), {
        width: pane.width,
        height: pane.height,
      });
      if (fit) {
        instance.setCenter(fit.centerX, fit.centerY, {
          zoom: fit.zoom,
          duration: 400,
        });
      }
    },
    [],
  );

  // Toggle the label-fade class only when the threshold is crossed
  // (setState with an unchanged value bails out — no re-render storm).
  const onMove = useCallback(
    (_event: unknown, viewport: { zoom: number }) =>
      setLowZoom(viewport.zoom < LABEL_FADE_ZOOM),
    [],
  );

  // Graph search: center happens in the panel (it owns the ReactFlow
  // context); pinning happens here (selection state lives in `nodes`).
  const onSearchSelect = useCallback(
    (nodeId: string) => {
      setNodes((current) =>
        current.map((node) =>
          node.selected !== (node.id === nodeId)
            ? ({ ...node, selected: node.id === nodeId } as typeof node)
            : node,
        ),
      );
      setPinnedNodeIds([nodeId]);
    },
    [setNodes],
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
          className={`flow-theme${lowZoom ? " flow-lowzoom" : ""}`}
          nodes={displayNodes}
          edges={displayEdges}
          onInit={(instance) => {
            rfInstance.current = instance;
            setLowZoom(instance.getZoom() < LABEL_FADE_ZOOM);
          }}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onEdgeMouseEnter={onEdgeMouseEnter}
          onEdgeMouseLeave={onEdgeMouseLeave}
          onEdgeClick={onEdgeClick}
          onMove={onMove}
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
          {/* Stable `nodes` (not displayNodes): spotlight flags are
              irrelevant to search, and the display array changes
              identity on every hover — which would rebuild the
              candidate list (~180 i18n lookups) per hover transition. */}
          <GraphSearchPanel nodes={nodes} onSelectResult={onSearchSelect} />
          <ExportImageButton containerRef={containerRef} />
        </ReactFlow>
      </div>
    </div>
  );
}
