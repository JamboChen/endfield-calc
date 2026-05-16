import type { Node } from "@xyflow/react";
import type { Item, Facility, Recipe } from "@/types";
import type { ProductionNode } from "@/types";

/**
 * Edge direction in the production flow graph.
 * - `forward`: standard producer → consumer flow (default).
 * - `backward`: same-SCC reverse edge; consumer feeds producer of the cycle.
 * - `self`: producer and consumer are the same node (self-loop).
 * - `internal`: producer and consumer are co-located in the same physical
 *   building (multi-formula bin). Internal flows never traverse pipes/belts;
 *   they're rendered distinctly so the user understands transport is free.
 */
export type EdgeDirection = "forward" | "backward" | "self" | "internal";

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
  ceilMode: boolean;
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
  ceilMode: boolean;
  [key: string]: unknown;
}

/**
 * Type alias for a target sink node in the React Flow graph.
 */
export type FlowTargetNode = Node<TargetSinkNodeData>;

/**
 * Data for a disposal sink node that consumes waste byproducts.
 * These nodes represent Liquid Cleaner facilities that destroy surplus byproducts.
 */
export interface DisposalSinkNodeData {
  /** The waste item being disposed */
  item: Item;
  /** Disposal rate in items/min (= surplus production) */
  disposalRate: number;
  /** The disposal facility (Liquid Cleaner) */
  facility: Facility;
  /** Number of disposal facilities needed */
  facilityCount: number;
  /** All available items (for icon rendering) */
  items: Item[];
  facilities: Facility[];
  ceilMode: boolean;
  [key: string]: unknown;
}

/**
 * Type alias for a disposal sink node in the React Flow graph.
 */
export type FlowDisposalNode = Node<DisposalSinkNodeData>;

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
