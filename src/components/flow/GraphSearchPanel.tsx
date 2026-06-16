import { useMemo, useState, useCallback } from "react";
import { Panel, useReactFlow, type Node } from "@xyflow/react";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { ItemIcon } from "../production/ProductionTable";
import { getDomainName, getItemName, getFacilityName } from "@/lib/i18n-helpers";
import {
  filterSearchCandidates,
  type SearchCandidate,
} from "@/lib/flow-search";
import type {
  Item,
  ProductionNode,
  TargetSinkNodeData,
  DisposalSinkNodeData,
} from "@/types";

/** Zoom used when jumping to a result from further out. */
const JUMP_MIN_ZOOM = 0.8;

interface GraphSearchPanelProps {
  nodes: Node[];
  /** Center + pin the node (sets React Flow selection → spotlight). */
  onSelectResult: (nodeId: string) => void;
}

interface DisplayCandidate extends SearchCandidate {
  item?: Item;
}

/**
 * "Ctrl-F for buildings": filters graph nodes by the names actually
 * displayed on their cards (headline item + facility, current locale)
 * and jumps to + pins the chosen one. Enter = first result; Escape
 * clears. Rendered inside <ReactFlow> so useReactFlow has context.
 */
export default function GraphSearchPanel({
  nodes,
  onSelectResult,
}: GraphSearchPanelProps) {
  const { t } = useTranslation("production");
  const { setCenter, getZoom } = useReactFlow();
  const [query, setQuery] = useState("");

  // Candidate list mirrors what the cards display. Keyed on the node-ID
  // SIGNATURE, not the array identity: dragging a node produces a new
  // `nodes` array every pointer-move frame, and rebuilding here would run
  // ~360 i18n lookups per frame. Labels depend only on which nodes exist
  // (ids), never on their positions; `jumpTo` reads fresh positions from
  // the prop at click time.
  const nodeIdsKey = useMemo(() => nodes.map((n) => n.id).join("\n"), [nodes]);
  const candidates = useMemo<DisplayCandidate[]>(() => {
    return nodes.map((node) => {
      if (node.type === "productionNode") {
        const data = node.data as {
          productionNode: ProductionNode;
          facilityIndex?: number;
          totalFacilities?: number;
        };
        const prod = data.productionNode;
        const indexSuffix =
          data.facilityIndex !== undefined && data.totalFacilities !== undefined
            ? ` ${data.facilityIndex + 1}/${data.totalFacilities}`
            : "";
        return {
          id: node.id,
          label: getItemName(prod.item),
          // Metastorage import sources have no facility — their card
          // chip shows "Metastorage · <source region>" instead, so the
          // search indexes that (the panel's contract is "names
          // actually displayed on the cards"). Also disambiguates the
          // import row from the item's local-producer row in results.
          sublabel: prod.metastorageImport
            ? `${t("tree.metastorage")} · ${getDomainName(prod.metastorageImport.sourceDomain)}`
            : prod.facility
              ? `${getFacilityName(prod.facility)}${indexSuffix}`
              : undefined,
          item: prod.item,
        };
      }
      if (node.type === "targetSink") {
        const data = node.data as unknown as TargetSinkNodeData;
        return {
          id: node.id,
          label: getItemName(data.item),
          sublabel: t("tree.target"),
          item: data.item,
        };
      }
      // disposalSink
      const data = node.data as unknown as DisposalSinkNodeData;
      return {
        id: node.id,
        label: getItemName(data.item),
        sublabel: t("tree.disposal"),
        item: data.item,
      };
    });
    // `nodes` is deliberately represented by `nodeIdsKey` (see comment
    // above); the closure reads node data that is invariant for a given
    // id set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIdsKey, t]);

  const results = useMemo(
    () =>
      filterSearchCandidates(candidates, query) as DisplayCandidate[],
    [candidates, query],
  );

  const jumpTo = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const width = node.measured?.width ?? node.width ?? 208;
      const height = node.measured?.height ?? node.height ?? 125;
      setCenter(node.position.x + width / 2, node.position.y + height / 2, {
        zoom: Math.max(getZoom(), JUMP_MIN_ZOOM),
        duration: 400,
      });
      onSelectResult(nodeId);
      setQuery("");
    },
    [nodes, setCenter, getZoom, onSelectResult],
  );

  return (
    <Panel position="top-left">
      <div className="w-60">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              } else if (e.key === "Enter" && results.length > 0) {
                jumpTo(results[0].id);
              }
            }}
            placeholder={t("tree.searchPlaceholder")}
            className="h-8 pl-8 text-xs bg-card shadow-sm"
            aria-label={t("tree.searchPlaceholder")}
          />
        </div>
        {query.trim().length > 0 && (
          <div className="mt-1 rounded-md border border-border bg-card shadow-md overflow-hidden">
            {results.length === 0 ? (
              <div className="px-2.5 py-2 text-xs text-muted-foreground">
                {t("tree.searchNoResults")}
              </div>
            ) : (
              results.map((result) => (
                <button
                  key={result.id}
                  type="button"
                  onClick={() => jumpTo(result.id)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                >
                  {result.item && <ItemIcon item={result.item} size="sm" />}
                  <span className="truncate font-medium">{result.label}</span>
                  {result.sublabel && (
                    <span className="ml-auto truncate text-muted-foreground">
                      {result.sublabel}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
