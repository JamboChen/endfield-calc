import type { Node } from "@xyflow/react";
import type { Item, Facility, Recipe } from "@/types";
import type { ProductionNode } from "@/types";

export type EdgeDirection = "forward" | "backward" | "self";

/**
 * Visualization mode for the production dependency tree.
 * - 'merged': Combines identical production steps and shows aggregated facility counts
 * - 'separated': Shows each individual facility as a separate node
 */
export type VisualizationMode = "merged" | "separated";

/**
 * Base interface for the data expected by the CustomProductionNode component.
 * This is used for both merged and separated visualization modes.
 */
export interface FlowNodeData {
  productionNode: ProductionNode;
  items: Item[];
  facilities: Facility[];
  ceilMode?: boolean;
  [key: string]: unknown;
}

/**
 * Extended node data for separated visualization mode.
 * Adds facility-specific information for individual facility instances.
 */
export interface FlowNodeDataSeparated extends FlowNodeData {
  /** Zero-based index of this facility among all facilities of the same type */
  facilityIndex?: number;
  /** Total number of facilities of this type in the production chain */
  totalFacilities?: number;
  /** Whether this facility is operating at partial capacity (less than 100%) */
  isPartialLoad?: boolean;
}

/**
 * Represents a single physical facility instance in separated mode.
 * Each instance has its own capacity and can be connected independently.
 */
export interface FacilityInstance {
  /** Unique identifier for this facility instance (e.g., "node-iron-smelting-0") */
  facilityId: string;
  /** Reference to the original node key for traceability */
  nodeKey: string;
  /** Zero-based index of this facility among facilities of the same type */
  facilityIndex: number;
  /** Maximum output rate this facility can produce (items per minute) */
  maxOutputRate: number;
  /** Actual output rate this facility is producing (may be less than max for the last facility) */
  actualOutputRate: number;
  /** Remaining capacity available for allocation to consumers (items per minute) */
  remainingCapacity: number;
}

/**
 * Entry in the capacity pool representing all facilities for a specific production step.
 * The pool manages allocation of production capacity to downstream consumers.
 */
export interface CapacityPoolEntry {
  /** The original production node this pool represents */
  productionNode: ProductionNode;
  /** Total production capacity across all facilities (items per minute) */
  totalCapacity: number;
  /** Array of individual facility instances that make up this production step */
  facilities: FacilityInstance[];
}

/**
 * Result of allocating capacity from a producer to a consumer.
 * Multiple allocations may be needed if a single producer can't satisfy all demand.
 */
export interface AllocationResult {
  /** Node ID of the source facility providing the allocation */
  sourceNodeId: string;
  /** Amount allocated in this result (items per minute) */
  allocatedAmount: number;
  /** Index of the facility providing this allocation */
  fromFacilityIndex: number;
}
/**
 * Extended FlowNodeData that includes target information.
 * Used when a production node is also a direct user-defined target.
 */
export interface FlowNodeDataWithTarget extends FlowNodeData {
  /** Whether this node is a direct user-defined target */
  isDirectTarget?: boolean;
  /** The rate requested as a direct target (if applicable) */
  directTargetRate?: number;
}

/**
 * Extended FlowNodeDataSeparated that includes target information.
 * Used in separated mode when a production node is also a direct user-defined target.
 */
export interface FlowNodeDataSeparatedWithTarget extends FlowNodeDataSeparated {
  /** Whether this node is a direct user-defined target */
  isDirectTarget?: boolean;
  /** The rate requested as a direct target (if applicable) */
  directTargetRate?: number;
}

/**
 * Production information for terminal targets (targets without downstream consumers).
 * Contains facility and recipe details that would normally be shown in a production node.
 */
export interface TerminalTargetProductionInfo {
  /** The facility used to produce this target item */
  facility: Facility | null;
  /** Number of facilities required to meet the target rate */
  facilityCount: number;
  /** The recipe used to produce this target item */
  recipe: Recipe | null;
}

/**
 * Represents data for a virtual sink node that collects production output for user-defined targets.
 * These nodes help visualize which items are final production goals vs intermediate products.
 */
export interface TargetSinkNodeData {
  /** The item being collected as a target */
  item: Item;
  /** The target production rate for this item */
  targetRate: number;
  /** All available items (for icon rendering) */
  items: Item[];
  facilities: Facility[];
  productionInfo?: TerminalTargetProductionInfo;
  ceilMode?: boolean;
  [key: string]: unknown;
}

/**
 * Type alias for a target sink node in the React Flow graph.
 */
export type FlowTargetNode = Node<TargetSinkNodeData>;

/**
 * Updated FlowProductionNode that can include target information.
 */
export type FlowProductionNode =
  | Node<FlowNodeData>
  | Node<FlowNodeDataSeparated>
  | Node<FlowNodeDataWithTarget>
  | Node<FlowNodeDataSeparatedWithTarget>;

declare module "@xyflow/react" {
  interface EdgeData {
    flowRate?: number;
    direction?: EdgeDirection;
  }
}
