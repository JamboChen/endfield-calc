import { createContext } from "react";

/**
 * Center-on + spotlight-pin a graph node by id, from inside a custom
 * node component. Provided by `ProductionDependencyTree` (which owns the
 * CONTROLLED `nodes` state) and consumed by `CustomEnvNode`'s buffed-
 * building links.
 *
 * Why a context instead of `useReactFlow().setNodes` from the node:
 * the tree renders CONTROLLED nodes (`nodes={displayNodes}`). Writing
 * selection via the React Flow instance mutates the internal store with
 * the currently-rendered (spotlight-decorated) nodes, freezing stale
 * decorations and desyncing selection from the controlled state — the
 * pin then never clears on a pane click. Routing through the tree's own
 * `setNodes` keeps everything in the controlled pipeline. Default is a
 * no-op so the node renders safely outside a provider (tests).
 */
export const NodeJumpContext = createContext<(nodeId: string) => void>(
  () => {},
);
