import { calculateProductionPlan } from "@/lib/calculator";
import { items, recipes, facilities, MAX_TARGETS } from "@/data";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { ProductionTarget } from "@/components/panels/TargetItemsGrid";
import type {
  ItemId,
  RecipeId,
  ProductionDependencyGraph,
  ProductionGraphNode,
} from "@/types";
import { useTranslation } from "react-i18next";
import { useProductionStats } from "./useProductionStats";
import { useProductionTable } from "./useProductionTable";

interface SavedPlan {
  version: string;
  targets: { itemId: string; rate: number }[];
  recipeOverrides: Record<string, string>;
  manualRawMaterials: string[];
  ceilMode: boolean;
}

interface ParsedHashState {
  targets: ProductionTarget[];
  recipeOverrides: Map<ItemId, RecipeId>;
  manualRawMaterials: Set<ItemId>;
  ceilMode: boolean;
}

function parseHash(): ParsedHashState {
  const defaultState: ParsedHashState = {
    targets: [],
    recipeOverrides: new Map(),
    manualRawMaterials: new Set(),
    ceilMode: false,
  };

  try {
    const hash = window.location.hash.slice(1); // remove leading '#'
    if (!hash) return defaultState;

    const params = new URLSearchParams(hash);
    const knownItemIds = new Set(items.map((item) => item.id));
    const knownRecipeIds = new Set(recipes.map((recipe) => recipe.id));

    // Parse targets: t=item_steel:6,item_glass:3
    const targetsRaw = params.get("t");
    const parsedTargets: ProductionTarget[] = [];
    if (targetsRaw) {
      for (const part of targetsRaw.split(",")) {
        const colonIdx = part.lastIndexOf(":");
        if (colonIdx === -1) continue;
        const itemId = part.slice(0, colonIdx) as ItemId;
        const rate = parseFloat(part.slice(colonIdx + 1));
        if (knownItemIds.has(itemId) && isFinite(rate) && rate >= 0) {
          parsedTargets.push({ itemId, rate });
        }
      }
    }

    // Parse recipeOverrides: r=item_steel:recipe_alloy
    const recipeRaw = params.get("r");
    const parsedRecipeOverrides = new Map<ItemId, RecipeId>();
    if (recipeRaw) {
      for (const part of recipeRaw.split(",")) {
        const colonIdx = part.indexOf(":");
        if (colonIdx === -1) continue;
        const itemId = part.slice(0, colonIdx) as ItemId;
        const recipeId = part.slice(colonIdx + 1) as RecipeId;
        if (knownItemIds.has(itemId) && knownRecipeIds.has(recipeId)) {
          parsedRecipeOverrides.set(itemId, recipeId);
        }
      }
    }

    // Parse manualRawMaterials: m=item_coal,item_wood
    const manualRaw = params.get("m");
    const parsedManualRawMaterials = new Set<ItemId>();
    if (manualRaw) {
      for (const rawId of manualRaw.split(",")) {
        const itemId = rawId as ItemId;
        if (knownItemIds.has(itemId)) {
          parsedManualRawMaterials.add(itemId);
        }
      }
    }

    // Parse ceilMode: c=1
    const ceilRaw = params.get("c");
    const parsedCeilMode = ceilRaw === "1";

    return {
      targets: parsedTargets,
      recipeOverrides: parsedRecipeOverrides,
      manualRawMaterials: parsedManualRawMaterials,
      ceilMode: parsedCeilMode,
    };
  } catch {
    return defaultState;
  }
}

function serializeHash(
  targets: ProductionTarget[],
  recipeOverrides: Map<ItemId, RecipeId>,
  manualRawMaterials: Set<ItemId>,
  ceilMode: boolean,
): string {
  const params = new URLSearchParams();

  if (targets.length > 0) {
    params.set("t", targets.map((t) => `${t.itemId}:${t.rate}`).join(","));
  }

  if (recipeOverrides.size > 0) {
    params.set(
      "r",
      Array.from(recipeOverrides.entries())
        .map(([itemId, recipeId]) => `${itemId}:${recipeId}`)
        .join(","),
    );
  }

  if (manualRawMaterials.size > 0) {
    params.set("m", Array.from(manualRawMaterials).join(","));
  }

  if (ceilMode) {
    params.set("c", "1");
  }

  return params.toString();
}


export function useProductionPlan() {
  const { t } = useTranslation("app");

  const initialState = useMemo(() => parseHash(), []);

  const [targets, setTargets] = useState<ProductionTarget[]>(
    initialState.targets,
  );
  const [recipeOverrides, setRecipeOverrides] = useState<Map<ItemId, RecipeId>>(
    initialState.recipeOverrides,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"table" | "tree">("table");
  const [manualRawMaterials, setManualRawMaterials] = useState<Set<ItemId>>(
    initialState.manualRawMaterials,
  );
  const [ceilMode, setCeilMode] = useState(initialState.ceilMode);

  useEffect(() => {
    const hash = serializeHash(
      targets,
      recipeOverrides,
      manualRawMaterials,
      ceilMode,
    );
    const newUrl = hash
      ? `${window.location.pathname}${window.location.search}#${hash}`
      : window.location.pathname + window.location.search;
    history.replaceState(null, "", newUrl);
  }, [targets, recipeOverrides, manualRawMaterials, ceilMode]);

  // Core calculation: only returns dependency tree and cycles
  const { plan, error } = useMemo(() => {
    let plan = null;
    let error: string | null = null;

    try {
      if (targets.length > 0) {
        plan = calculateProductionPlan(
          targets,
          items,
          recipes,
          facilities,
          recipeOverrides,
          manualRawMaterials,
        );
      }
    } catch (e) {
      error = e instanceof Error ? e.message : t("calculationError");
    }

    return { plan, error };
  }, [targets, recipeOverrides, manualRawMaterials, t]);

  // Filter zero-rate nodes from the plan for display
  const displayPlan = useMemo(() => {
    if (!plan) return plan;
    // Filter 0-rate nodes, but never filter out target items
    const activeNodes = new Map<string, ProductionGraphNode>();
    for (const [key, node] of plan.nodes) {
      if (node.type === "recipe" && node.facilityCount === 0) continue;
      if (node.type === "item" && node.productionRate === 0 && !plan.targets.has(node.itemId)) continue;
      activeNodes.set(key, node);
    }
    // Filter edges that connect to removed nodes
    const activeEdges = plan.edges.filter(
      (edge) => activeNodes.has(edge.from) && activeNodes.has(edge.to)
    );
    return { ...plan, nodes: activeNodes, edges: activeEdges } as ProductionDependencyGraph;
  }, [plan]);

  // View-specific data: computed in view layer hooks
  const stats = useProductionStats(displayPlan, manualRawMaterials, ceilMode, items);
  const tableData = useProductionTable(
    displayPlan,
    recipes,
    recipeOverrides,
    manualRawMaterials,
  );

  const handleTargetChange = useCallback((index: number, rate: number) => {
    setTargets((prev) => {
      const newTargets = [...prev];
      newTargets[index].rate = rate;
      return newTargets;
    });
  }, []);

  const handleTargetRemove = useCallback((index: number) => {
    setTargets((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleBatchAddTargets = useCallback(
    (newTargets: { itemId: ItemId; rate: number }[]) => {
      setTargets((prev) => {
        const existingIds = new Set(prev.map((t) => t.itemId));
        const unique = newTargets.filter((t) => !existingIds.has(t.itemId));
        return [...prev, ...unique].slice(0, MAX_TARGETS);
      });
    },
    [],
  );

  const handleRecipeChange = useCallback(
    (itemId: ItemId, recipeId: RecipeId) => {
      setRecipeOverrides((prev) => {
        const newMap = new Map(prev);
        newMap.set(itemId, recipeId);
        return newMap;
      });
    },
    [],
  );

  const handleAddClick = useCallback(() => {
    setDialogOpen(true);
  }, []);

  const handleToggleRawMaterial = useCallback((itemId: ItemId) => {
    setManualRawMaterials((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  }, []);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSavePlan = useCallback(() => {
    const data: SavedPlan = {
      version: "1",
      targets: targets.map((t) => ({ itemId: t.itemId, rate: t.rate })),
      recipeOverrides: Object.fromEntries(recipeOverrides),
      manualRawMaterials: Array.from(manualRawMaterials),
      ceilMode,
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "production-plan.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [targets, recipeOverrides, manualRawMaterials, ceilMode]);

  const handleOpenPlan = useCallback(() => {
    if (!fileInputRef.current) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const data = JSON.parse(ev.target?.result as string) as SavedPlan;
            if (data.version !== "1") return;
            setTargets(
              data.targets.map((t) => ({ itemId: t.itemId as ItemId, rate: t.rate })),
            );
            setRecipeOverrides(
              new Map(
                Object.entries(data.recipeOverrides).map(([k, v]) => [
                  k as ItemId,
                  v as RecipeId,
                ]),
              ),
            );
            setManualRawMaterials(new Set(data.manualRawMaterials as ItemId[]));
            setCeilMode(data.ceilMode);
          } catch {
            // ignore invalid files
          }
        };
        reader.readAsText(file);
      };
      fileInputRef.current = input;
    }
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  }, []);

  return {
    targets,
    setTargets,
    recipeOverrides,
    setRecipeOverrides,
    dialogOpen,
    setDialogOpen,
    activeTab,
    setActiveTab,
    plan: displayPlan,
    tableData,
    stats,
    error,
    ceilMode,
    setCeilMode,
    handleTargetChange,
    handleTargetRemove,
    handleBatchAddTargets,
    handleToggleRawMaterial,
    handleRecipeChange,
    handleAddClick,
    handleSavePlan,
    handleOpenPlan,
  };
}
