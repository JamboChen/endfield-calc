import { useMemo, useEffect } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  type NodeTypes,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
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
import { useTranslation } from "react-i18next";
import { getLayoutedElements } from "@/lib/layout";
import { mapPlanToFlowMerged } from "../mappers/merged-mapper";
import { mapPlanToFlowSeparated } from "../mappers/separated-mapper";
import { applyEdgeStyling } from "./flow-utils";
import CustomBackwardEdge from "../nodes/CustomBackwardEdge";
import CustomBezierEdge from "../nodes/CustomBezierEdge";

type ProductionDependencyTreeProps = {
  plan: ProductionDependencyGraph | null;
  items: Item[];
  facilities: Facility[];
  visualizationMode?: VisualizationMode;
  targetRates?: Map<ItemId, number>;
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
}: ProductionDependencyTreeProps) {
  const { t } = useTranslation("production");

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

      // Get translated belt label
      const beltLabel = t("belt.belts");

      // Select mapper - now passes DAG structure instead of tree
      const flowData =
        visualizationMode === "separated"
          ? mapPlanToFlowSeparated(plan, items, facilities, beltLabel, targetRates)
          : mapPlanToFlowMerged(plan, items, facilities, beltLabel, targetRates);

      const { nodes: layoutedNodes, edges: layoutedEdges } =
        await getLayoutedElements(flowData.nodes, flowData.edges, "RIGHT");

      if (!isMounted) return;

      const styledEdges = applyEdgeStyling(layoutedEdges, layoutedNodes);

      setNodes(layoutedNodes as FlowProductionNode[]);
      setEdges(styledEdges);
    }

    computeLayout();

    return () => {
      isMounted = false;
    };
  }, [plan, items, facilities, visualizationMode, targetRates, setNodes, setEdges]);

  const nodeTypes: NodeTypes = useMemo(
    () => ({
      productionNode: CustomProductionNode,
      targetSink: CustomTargetNode,
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
      <div className="flex-1">
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
        </ReactFlow>
      </div>
    </div>
  );
}
