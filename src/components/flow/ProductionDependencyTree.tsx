import {
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  startTransition,
} from "react";
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
  type Viewport,
  Panel,
  useReactFlow,
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
import CustomPowerNode from "../nodes/CustomPowerNode";
import CustomEnvNode from "../nodes/CustomEnvNode";
import { useTranslation } from "react-i18next";
import { LayoutCancelledError } from "@/lib/layout";
import {
  computeFlowLayout,
  decideCameraAction,
  getCachedLayout,
  layoutComboKey,
  setCachedLayout,
  useCoalescedInteractiveJob,
  type LayoutInputs,
  type PendingCameraAction,
} from "./layout-cache";
import {
  getNeighborhood,
  getPinnedSpotlight,
  mergeSpotlights,
} from "@/lib/flow-spotlight";
import { edgeBounds, computeEdgeFitView } from "@/lib/edge-fit";
import GraphSearchPanel from "./GraphSearchPanel";
import { NodeJumpContext } from "./node-jump-context";
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
import SolverLoadingOverlay from "@/components/production/SolverLoadingOverlay";

const EXPORT_FORMATS = ["svg", "png"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

function isExportFormat(v: string): v is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(v);
}

const CONTENT_PADDING = 0.1; // 10% padding around nodes

/** Below this zoom, edge labels fade out (spotlit/hovered edges exempt). */
const LABEL_FADE_ZOOM = 0.5;

/** Min zoom a node-jump lands at (mirrors the search panel's jump). */
const NODE_JUMP_MIN_ZOOM = 0.8;

/** Layout-busy overlay debounce — matches the solver overlay's
 *  threshold so sub-perceptible layouts never flash it. */
const LAYOUT_OVERLAY_DEBOUNCE_MS = 300;

/** Cache-hit restores above this node count show the busy overlay
 *  IMMEDIATELY (no debounce): the DOM commit + React Flow measurement
 *  of a big graph blocks the main thread up to ~2.5s and is not
 *  time-sliceable, so the user gets the dimmed-canvas feedback painted
 *  BEFORE the freeze. Small restores skip it — their freeze is shorter
 *  than the flash would be. */
const RESTORE_OVERLAY_MIN_NODES = 100;

function ExportImageButton({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation("production");
  // Instance-bound `getNodesBounds` (store nodeLookup included), NOT
  // the standalone xyflow util — the standalone dev-warns without a
  // nodeLookup. Store-backed is exactly right here: the nodes being
  // measured come from `getNodes()` (the same store).
  const { getNodes, getNodesBounds } = useReactFlow();
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

    // The low-zoom label fade tracks the LIVE viewport zoom, but the
    // export renders at its own computed transform — exporting while
    // zoomed out would bake the faded (invisible) labels into the image.
    // Strip the class for the capture; spotlight dim state stays as-is
    // (WYSIWYG by design).
    const flowEl = containerRef.current?.querySelector(".react-flow");
    const hadLowZoom = flowEl?.classList.contains("flow-lowzoom") ?? false;
    if (hadLowZoom) flowEl!.classList.remove("flow-lowzoom");

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
      })
      .finally(() => {
        if (hadLowZoom) flowEl!.classList.add("flow-lowzoom");
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

  // Live view mirror for the snapshot-on-switch-out path: the layout
  // effect must read the CURRENT nodes/edges (manual drags included)
  // without depending on them — that would re-run layout on every drag.
  const liveViewRef = useRef<{ nodes: FlowProductionNode[]; edges: Edge[] }>({
    nodes: [],
    edges: [],
  });
  liveViewRef.current = { nodes, edges };

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
  // Layout-in-flight overlay. ELK runs multi-second on large Facility
  // View graphs (~2s at 250 nodes, ~4.6s at 425 with NETWORK_SIMPLEX
  // placement) while the STALE graph stays on screen — without
  // feedback the mode-switch click looks dead. Mirrors the solver
  // overlay's 300ms debounce (see `SolverLoadingOverlay`) so fast
  // layouts never flash it; back-to-back solve → layout busy states
  // share the same visuals and read as one.
  const [showLayoutOverlay, setShowLayoutOverlay] = useState(false);
  const rfInstance = useRef<ReactFlowInstance<FlowProductionNode, Edge> | null>(
    null,
  );
  // Mode of the previous layout run. Formula View and Facility View
  // occupy wildly different extents (one card per bin vs one per
  // building), so a camera kept from the other mode can land in empty
  // space — re-fit on the switch. Deliberately ONLY for the
  // Formula/Facility switch: bin-fusion / alignment toggles and plan
  // recomputes preserve the camera. `null` = no layout yet (first
  // mount keeps the `fitView` prop behaviour). Cache HITS carrying a
  // snapshotted viewport skip the re-fit — the stored camera wins.
  const lastLayoutModeRef = useRef<VisualizationMode | null>(null);

  // Inputs of the most recently REQUESTED view — drives the "did the
  // combo change" snapshot trigger in the layout effect.
  const lastComboRef = useRef<LayoutInputs | null>(null);
  // Inputs of the graph actually COMMITTED to the canvas. Snapshots
  // key off THIS, not the requested combo: the request is recorded
  // synchronously while the swap rides a transition, and an unmount
  // landing in that window would otherwise write the still-committed
  // OLD nodes under the NEW combo's cache entry. Promotion happens in
  // the nodes-keyed layout effect, matched by array identity.
  const pendingComboRef = useRef<{
    inputs: LayoutInputs;
    nodes: FlowProductionNode[];
  } | null>(null);
  const committedComboRef = useRef<LayoutInputs | null>(null);
  // Camera action parked for the pending graph swap — consumed by the
  // nodes-keyed layout effect below (or by onInit on a tab-flip
  // remount, whichever sees a ready ReactFlow instance first).
  const pendingCameraRef = useRef<PendingCameraAction | null>(null);
  // Interactive-lane single-flight scheduling (latest-wins coalescing +
  // stale-job termination) — see `useCoalescedInteractiveJob`.
  const scheduleLayoutJob = useCoalescedInteractiveJob();

  // Snapshot the on-screen view (drags + camera) into its combo's cache
  // entry. `selected` is normalized off so a React Flow selection ring
  // can't survive a restore whose spotlight state was cleared.
  const snapshotCurrentView = useCallback(() => {
    const committed = committedComboRef.current;
    if (!committed) return;
    const { nodes: liveNodes, edges: liveEdges } = liveViewRef.current;
    if (liveNodes.length === 0) return;
    setCachedLayout(committed, {
      nodes: liveNodes.map((n) => ({ ...n, selected: false })),
      edges: liveEdges,
      viewport: rfInstance.current?.getViewport(),
    });
  }, []);

  // Tab flips unmount the tree (Radix TabsContent, no forceMount) —
  // snapshot on unmount so returning restores the exact view. Empty
  // deps = unmount-only cleanup.
  useEffect(() => () => snapshotCurrentView(), [snapshotCurrentView]);

  // Re-center on a Formula ↔ Facility switch. Computed from the
  // in-hand layouted nodes (positions + dimensions set by
  // getLayoutedElements) instead of fitView() so there's no race
  // against the store receiving the new nodes. Limits/padding match
  // the fitViewOptions on the ReactFlow element.
  const fitToNodes = useCallback((layoutedNodes: Node[], animate: boolean) => {
    const pane = containerRef.current?.getBoundingClientRect();
    if (!pane || !rfInstance.current || layoutedNodes.length === 0) return;
    // Local bounds fold instead of xyflow's `getNodesBounds`:
    // the standalone util dev-warns without a store nodeLookup,
    // and the store-backed instance method would re-introduce
    // the store race this block deliberately avoids (it
    // resolves nodes BY ID from the store, which hasn't
    // received the new nodes yet). ELK layout gives every node
    // explicit position + width/height and none has a parentId,
    // so a plain min/max fold is exact.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of layoutedNodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + (n.width ?? 0));
      maxY = Math.max(maxY, n.position.y + (n.height ?? 0));
    }
    const bounds = {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
    const viewport = getViewportForBounds(
      bounds,
      pane.width,
      pane.height,
      0.1,
      1.5,
      0.2,
    );
    // Mode switches glide (deliberate 300ms); mount restores apply
    // instantly — an animation FROM the default camera would itself
    // read as a layout shift.
    rfInstance.current.setViewport(
      viewport,
      animate ? { duration: 300 } : undefined,
    );
  }, []);

  // Consume the parked camera action in the SAME painted frame as the
  // graph swap it belongs to: layout effects run before the commit
  // paints, so camera + nodes change atomically (see
  // `PendingCameraAction`). Ref-check no-op on every other nodes
  // change (drags etc.). When the ReactFlow instance isn't ready yet
  // (tab-flip remount ordering), the action stays parked for onInit.
  useLayoutEffect(() => {
    // Promote the committed combo when the ARRAY we handed to setNodes
    // is what actually landed (identity match — drags and interleaved
    // older commits can't mis-promote).
    const pendingCombo = pendingComboRef.current;
    if (pendingCombo && nodes === pendingCombo.nodes) {
      committedComboRef.current = pendingCombo.inputs;
      pendingComboRef.current = null;
    }
    const action = pendingCameraRef.current;
    if (!action || !rfInstance.current) return;
    pendingCameraRef.current = null;
    if (action.type === "viewport") {
      rfInstance.current.setViewport(action.viewport);
    } else {
      fitToNodes(action.nodes, action.animate);
    }
  }, [nodes, fitToNodes]);

  // Cache entry THIS mount will restore (tab-flip remount), captured
  // once at first render. Two jobs:
  //   - `defaultViewport`: a snapshotted camera initializes ReactFlow
  //     AT the restored viewport from frame one — a post-hoc
  //     `setViewport` correction raced RF's `onInit` against the
  //     transition's nodes commit, painting the graph at the default
  //     camera for a few frames before jumping (the Table → Tree
  //     "layout shift").
  //   - `fitView` suppression: whenever ANY entry restores at mount, we
  //     own the camera (stored viewport, or a parked instant fit for
  //     viewport-less prefetched entries) — RF's deferred initial fit
  //     would land late, after node measurement, as a visible jump. The
  //     prop stays on only for a true first-ever mount with nothing
  //     cached, where it is the only fit available.
  // useState lazy initializer: runs exactly once per instance, and the
  // committed value is stable even if a concurrent render is discarded
  // (unlike a render-phase ref write).
  const [mountRestore] = useState<{ viewport?: Viewport } | null>(() =>
    plan && plan.nodes.size > 0
      ? (getCachedLayout({
          plan,
          items,
          recipes,
          facilities,
          targetRates,
          visualizationMode,
          twoEndAlignment,
          ceilMode,
          binFusion,
        }) ?? null)
      : null,
  );

  useEffect(() => {
    let isMounted = true;
    // Debounced busy overlay: armed for every run, cleared in the
    // shared `finally`. A run that outlives the deps (cleanup fired)
    // leaves the overlay to the SUCCESSOR run's timer — continuous
    // busy state across rapid toggles, no flicker.
    const overlayTimer = window.setTimeout(() => {
      if (isMounted) setShowLayoutOverlay(true);
    }, LAYOUT_OVERLAY_DEBOUNCE_MS);
    const finish = () => {
      window.clearTimeout(overlayTimer);
      if (isMounted) setShowLayoutOverlay(false);
    };
    const cleanup = () => {
      isMounted = false;
      window.clearTimeout(overlayTimer);
    };

    // Stale spotlight ids must not survive a plan/mode change.
    setHoveredNodeId(null);
    setPinnedNodeIds([]);
    setHoveredEdgeId(null);

    if (!plan || plan.nodes.size === 0) {
      lastComboRef.current = null;
      pendingCameraRef.current = null;
      pendingComboRef.current = null;
      committedComboRef.current = null;
      setNodes([]);
      setEdges([]);
      finish();
      return cleanup;
    }

    const inputs: LayoutInputs = {
      plan,
      items,
      recipes,
      facilities,
      targetRates,
      visualizationMode,
      twoEndAlignment,
      ceilMode,
      binFusion,
    };

    // Snapshot the outgoing view (drags + camera) into its cache entry
    // before replacing it. The TRIGGER compares requested combos; the
    // WRITE keys off the COMMITTED combo (see committedComboRef) so an
    // uncommitted in-flight swap can't mis-file the old view. A
    // snapshot against a superseded plan lands in a WeakMap entry that
    // dies with that plan, harmlessly.
    if (
      lastComboRef.current &&
      layoutComboKey(lastComboRef.current) !== layoutComboKey(inputs)
    ) {
      snapshotCurrentView();
    }
    lastComboRef.current = inputs;

    // Canvas currently empty (fresh mount / tab-flip remount / after an
    // empty plan) — the incoming graph must bring its own camera, and
    // `modeChanged` can't cover it (there is no previous mode). Checked
    // against the LIVE canvas, not a first-run flag: effect re-runs for
    // the same combo before the nodes commit (StrictMode double-invoke,
    // dep identity churn) must park the same action again, not null it.
    const canvasEmpty = liveViewRef.current.nodes.length === 0;
    const modeChanged =
      lastLayoutModeRef.current !== null &&
      lastLayoutModeRef.current !== visualizationMode;
    lastLayoutModeRef.current = visualizationMode;

    // Cache hit (prior visit snapshot or background prefetch): restore
    // without mapper/ELK. The graph replacement is a TRANSITION:
    // replacing hundreds of node/edge components in one urgent render
    // blocked the main thread right on the click (measured 444+194ms at
    // 46 nodes, 1183+1250ms at 356 — the tab/radio flip couldn't even
    // paint). The render phase is time-sliced as a transition; the DOM
    // commit + React Flow measurement pass remain one synchronous
    // chunk, which is why big restores urgently paint the busy overlay
    // FIRST (below) — click feedback lands before the freeze.
    const cached = getCachedLayout(inputs);
    if (cached) {
      window.clearTimeout(overlayTimer);
      // Urgent overlay for big restores: paints together with the
      // tab/radio flip, before the graph-commit freeze. Cleared INSIDE
      // the transition so it disappears exactly when the graph lands.
      if (cached.nodes.length > RESTORE_OVERLAY_MIN_NODES) {
        setShowLayoutOverlay(true);
      }
      const restoredNodes = cached.nodes.map((n) => ({
        ...n,
        selected: false,
      })) as FlowProductionNode[];
      startTransition(() => {
        setNodes(restoredNodes);
        setEdges(cached.edges);
        setShowLayoutOverlay(false);
      });
      pendingComboRef.current = { inputs, nodes: restoredNodes };
      // Park the camera change for the swap's commit (atomic with the
      // new graph — never applied against the outgoing one). On a fresh
      // mount the snapshotted viewport is already live via
      // `defaultViewport` — re-parking it is an idempotent no-op.
      pendingCameraRef.current = decideCameraAction({
        viewport: cached.viewport,
        nodes: cached.nodes,
        modeChanged,
        canvasEmpty,
      });
      // No finish() here: the timer is already cleared and the overlay
      // hide rides the transition so it lifts exactly with the graph.
      return cleanup;
    }

    // MISS → compute on the interactive lane. Single-flight scheduling
    // (latest-wins coalescing + stale-job termination) is owned by
    // `useCoalescedInteractiveJob`; this run owns everything per-run.
    scheduleLayoutJob(async () => {
      try {
        // Yield one macrotask before the synchronous mapper: it can
        // block the main thread a few hundred ms on big plans, and
        // without the yield the toggle's own re-render (and, past the
        // debounce, the overlay) wouldn't paint until the first
        // genuine await.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!isMounted) return;
        const result = await computeFlowLayout(inputs, "interactive");
        // Even a superseded result is internally consistent — warm
        // the cache for its combo before bailing.
        setCachedLayout(inputs, result);
        if (!isMounted) return;
        // Transition for the same reason as the cache-hit restore:
        // the giant commit must not freeze whatever the user is
        // doing when the layout finally lands.
        const resultNodes = result.nodes as FlowProductionNode[];
        pendingComboRef.current = { inputs, nodes: resultNodes };
        pendingCameraRef.current = decideCameraAction({
          nodes: result.nodes,
          modeChanged,
          canvasEmpty,
        });
        startTransition(() => {
          setNodes(resultNodes);
          setEdges(result.edges);
        });
      } catch (error) {
        // Cancellation = superseded by a newer run; anything else is
        // unexpected (getLayoutedElements degrades internally).
        if (!(error instanceof LayoutCancelledError)) {
          console.error("Layout pipeline failed:", error);
        }
      } finally {
        window.clearTimeout(overlayTimer);
        // Hide via transition: on the success path this batches with
        // the graph commit above (overlay lifts exactly when the new
        // graph lands, not before its commit freeze); on error/cancel
        // paths there's no heavy render pending and it hides promptly.
        if (isMounted) {
          startTransition(() => setShowLayoutOverlay(false));
        }
      }
    });

    return cleanup;
  }, [plan, items, recipes, facilities, visualizationMode, targetRates, twoEndAlignment, ceilMode, binFusion, setNodes, setEdges, snapshotCurrentView, scheduleLayoutJob]);

  const nodeTypes: NodeTypes = useMemo(
    () => ({
      productionNode: CustomProductionNode,
      targetSink: CustomTargetNode,
      disposalSink: CustomDisposalNode,
      powerSink: CustomPowerNode,
      envSink: CustomEnvNode,
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
  //
  // Decorated variants are cached per BASE node object: while dragging, a
  // spotlight is always active (the pointer hovers/pins the dragged node)
  // and `nodes` gets a new array identity every pointer-move frame — but
  // `applyNodeChanges` keeps every NON-dragged node reference-stable.
  // Returning the same decorated object for the same base node lets
  // React Flow's per-node memo skip re-rendering ~150 dimmed cards per
  // frame (measured: 333–433ms p95 drag frames without the cache). The
  // decoration depends only on the base node + which variant applies, so
  // base-object identity is a sound cache key; stale entries die with
  // their keys (WeakMap).
  const decoratedNodeCache = useRef(
    new WeakMap<
      FlowProductionNode,
      { dim?: FlowProductionNode; consumer?: FlowProductionNode }
    >(),
  );
  const displayNodes = useMemo(() => {
    if (!spotlight) return nodes;
    const cache = decoratedNodeCache.current;
    return nodes.map((node) => {
      if (!spotlight.nodeIds.has(node.id)) {
        const hit = cache.get(node);
        if (hit?.dim) return hit.dim;
        const dim = { ...node, className: "spotlight-dim" } as typeof node;
        cache.set(node, { ...hit, dim });
        return dim;
      }
      if (spotlight.consumerNodeIds.has(node.id)) {
        const hit = cache.get(node);
        if (hit?.consumer) return hit.consumer;
        const consumer = {
          ...node,
          data: { ...node.data, pinConsumer: true },
        } as typeof node;
        cache.set(node, { ...hit, consumer });
        return consumer;
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

  // Center + spotlight-pin a node from inside a custom node (the env
  // card's buffed-building links — see `NodeJumpContext`). Centering
  // goes through the instance; selection MUST go through `onSearchSelect`
  // (the CONTROLLED `nodes` state), not `useReactFlow().setNodes`, or the
  // node decorations freeze and the pin never clears on a pane click.
  const jumpToNode = useCallback(
    (nodeId: string) => {
      const instance = rfInstance.current;
      const node = instance?.getNode(nodeId);
      if (instance && node) {
        const width = node.measured?.width ?? node.width ?? 208;
        const height = node.measured?.height ?? node.height ?? 125;
        instance.setCenter(
          node.position.x + width / 2,
          node.position.y + height / 2,
          { zoom: Math.max(instance.getZoom(), NODE_JUMP_MIN_ZOOM), duration: 400 },
        );
      }
      onSearchSelect(nodeId);
    },
    [onSearchSelect],
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
      <div className="flex-1 relative" ref={containerRef}>
        {showLayoutOverlay && (
          <SolverLoadingOverlay
            label={t("tree.arranging", { defaultValue: "Arranging graph" })}
          />
        )}
        <NodeJumpContext.Provider value={jumpToNode}>
        <ReactFlow
          className={`flow-theme${lowZoom ? " flow-lowzoom" : ""}`}
          nodes={displayNodes}
          edges={displayEdges}
          onInit={(instance) => {
            rfInstance.current = instance;
            // Tab-flip remount with a parked camera action: the
            // cache-hit effect (and its nodes-keyed layout effect) may
            // have run before this instance existed.
            const action = pendingCameraRef.current;
            if (action) {
              pendingCameraRef.current = null;
              if (action.type === "viewport") {
                instance.setViewport(action.viewport);
              } else {
                fitToNodes(action.nodes, action.animate);
              }
            }
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
          // Mount restores own the camera (see mountRestore):
          // initialize AT the snapshotted viewport and suppress RF's
          // deferred initial fit whenever any entry restores.
          defaultViewport={mountRestore?.viewport}
          fitView={!mountRestore}
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
          {/* Hidden in portrait: at phone widths the minimap covered
              ~40% of the canvas while the graph itself is pinch-
              navigable anyway. */}
          <MiniMap
            pannable
            zoomable
            className="[@media(orientation:portrait)]:hidden"
          />
          {/* Stable `nodes` (not displayNodes): spotlight flags are
              irrelevant to search, and the display array changes
              identity on every hover — which would rebuild the
              candidate list (~180 i18n lookups) per hover transition. */}
          <GraphSearchPanel nodes={nodes} onSelectResult={onSearchSelect} />
          <ExportImageButton containerRef={containerRef} />
        </ReactFlow>
        </NodeJumpContext.Provider>
      </div>
    </div>
  );
}
