/**
 * Phase 3: pack multi-formula facility recipes into shared buildings.
 *
 * Given Phase 2's per-recipe slot demands (`recipeFacilityCounts`), this
 * module decides how those slots are physically realised. For facilities
 * with `capabilities` defined (e.g. Reactor / Expanded Crucible), multiple
 * recipes may share a single building, sharing inner-slot inventory and
 * external port budget. Each "bin" of buildings has the same recipe
 * configuration; each building of that bin provides 1 slot of each
 * constituent recipe per cycle.
 *
 * Algorithm:
 *   1. Group recipes by facility. Per facility, enumerate all valid
 *      bin shapes (subsets of recipes with that facilityId or its
 *      twin variants — see `findRecipeAlternatives`) using DFS with
 *      cap-violation pruning.
 *   2. For each pool of recipes that share equivalent I/O across
 *      facilities (e.g. `MIX_POOL_1` ↔ `MIX_POOL_2` byte-identical
 *      twins), expose all variants to the ILP so it can pick whichever
 *      facility best amortizes power and building cost.
 *   3. Solve a lex two-pass MIP:
 *        - Pass 1: minimise total buildings (Σ x_t).
 *        - Pass 2: minimise total power subject to pass-1 optimum.
 *   4. Emit `CrucibleBin[]` with per-bin net I/O metadata, plus a
 *      per-recipe `RecipeBinAllocation` distributing slot demand across
 *      the chosen bins.
 *
 * Recipes with no `capabilities`-aware facility produce a trivial
 * singleton bin per recipe so downstream consumers always see a uniform
 * data shape.
 */

import solver from "javascript-lp-solver";
import { calcRate } from "@/lib/utils";
import type {
  Item,
  Recipe,
  Facility,
  ItemId,
  RecipeId,
  FacilityId,
  CrucibleBin,
  RecipeBinAllocation,
} from "@/types";

/** Numerical tolerance below which net flow is treated as zero (fully internal). */
const NET_FLOW_EPSILON = 1e-9;

/** Tolerance for treating slot demands as zero. Mirrors `LP_EPSILON` in lp-solver. */
const SLOT_DEMAND_EPSILON = 1e-9;

/** Building-count slack added to lex pass 2's cap to absorb LP noise. */
const LEX_BUILDINGS_TOLERANCE = 1e-6;

export type PackingInput = {
  /** Per-recipe slot demands from Phase 2. */
  recipeSlotDemands: Map<RecipeId, number>;
  recipeMap: Map<RecipeId, Recipe>;
  itemMap: Map<ItemId, Item>;
  facilityMap: Map<FacilityId, Facility>;
  /**
   * Optional user-pinned recipe variants. When set for an item, the
   * solver forces the corresponding recipe to be the producer. The
   * packer respects this by treating non-pinned twins as unavailable
   * substitutes for the pinned recipe's slot demand.
   */
  recipeOverrides?: Map<ItemId, RecipeId>;
};

export type PackingResult = {
  bins: CrucibleBin[];
  allocations: Map<RecipeId, RecipeBinAllocation>;
};

/** Bin "shape": a recipe subset hosted by one facility type. */
type BinShape = {
  facility: Facility;
  /** Sorted recipe IDs (deterministic). */
  recipeIds: RecipeId[];
  /** Cached net I/O at 1-slot-per-recipe rates. */
  netInputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }>;
  netOutputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }>;
  internalItems: ItemId[];
  innerSlotsUsed: number;
};

/**
 * Given a recipe `r`, find every recipe in the data set that is
 * functionally equivalent (same inputs, outputs, craftingTime — modulo
 * recipe ID and facility ID). The packer uses these as substitutes:
 * any unit of `r`'s slot demand may be served by any equivalent recipe
 * since they produce identical I/O at the same rate.
 *
 * This is the mechanism by which `_1` and `_2` pool recipes both become
 * candidates for the LP regardless of which one Phase 2 picked.
 */
const findRecipeAlternatives = (
  target: Recipe,
  recipes: Recipe[],
): Recipe[] => {
  const targetSig = recipeSignature(target);
  return recipes.filter((r) => recipeSignature(r) === targetSig);
};

/**
 * Stable signature for a recipe: sorted I/O lines plus crafting time.
 * Excludes `id` and `facilityId` so byte-identical twins on different
 * facilities collapse to the same signature.
 */
const recipeSignature = (r: Recipe): string => {
  const ins = r.inputs
    .map((i) => `${i.itemId}:${i.amount}`)
    .sort()
    .join(",");
  const outs = r.outputs
    .map((o) => `${o.itemId}:${o.amount}`)
    .sort()
    .join(",");
  return `in:${ins}|out:${outs}|t:${r.craftingTime}`;
};

/**
 * Compute the net per-slot I/O of a candidate recipe set, treating each
 * recipe as contributing exactly 1 slot. Returns `null` if the
 * combination violates `facility.capabilities`.
 */
const buildBinShape = (
  recipes: Recipe[],
  facility: Facility,
  itemMap: Map<ItemId, Item>,
): BinShape | null => {
  const caps = facility.capabilities;
  if (!caps) return null;
  if (caps.maxFormulas !== undefined && recipes.length > caps.maxFormulas) {
    return null;
  }

  // Per-item net rate at 1 slot per recipe.
  const netRates = new Map<ItemId, number>();
  const itemTouched = new Set<ItemId>();
  for (const r of recipes) {
    for (const inp of r.inputs) {
      itemTouched.add(inp.itemId);
      netRates.set(
        inp.itemId,
        (netRates.get(inp.itemId) ?? 0) - calcRate(inp.amount, r.craftingTime),
      );
    }
    for (const out of r.outputs) {
      itemTouched.add(out.itemId);
      netRates.set(
        out.itemId,
        (netRates.get(out.itemId) ?? 0) + calcRate(out.amount, r.craftingTime),
      );
    }
  }

  if (itemTouched.size > caps.innerSlots) return null;

  const netInputs: BinShape["netInputs"] = [];
  const netOutputs: BinShape["netOutputs"] = [];
  const internalItems: ItemId[] = [];

  let liquidIn = 0;
  let liquidOut = 0;
  let beltIn = 0;
  let beltOut = 0;

  for (const itemId of itemTouched) {
    const net = netRates.get(itemId) ?? 0;
    const item = itemMap.get(itemId);
    const isLiquid = item?.isLiquid ?? false;

    if (Math.abs(net) <= NET_FLOW_EPSILON) {
      internalItems.push(itemId);
      continue;
    }
    if (net < 0) {
      const rate = -net;
      netInputs.push({ itemId, rate, isLiquid });
      if (isLiquid) liquidIn += 1;
      else beltIn += 1;
    } else {
      netOutputs.push({ itemId, rate: net, isLiquid });
      if (isLiquid) liquidOut += 1;
      else beltOut += 1;
    }
  }

  if (liquidIn > caps.liquidInPorts) return null;
  if (liquidOut > caps.liquidOutPorts) return null;
  if (beltOut > caps.beltOutPorts) return null;
  if (caps.beltInPorts !== undefined && beltIn > caps.beltInPorts) return null;

  // Sort for deterministic output.
  const byItemId = (
    a: { itemId: ItemId },
    b: { itemId: ItemId },
  ) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);
  netInputs.sort(byItemId);
  netOutputs.sort(byItemId);
  internalItems.sort();

  return {
    facility,
    recipeIds: recipes.map((r) => r.id).sort(),
    netInputs,
    netOutputs,
    internalItems,
    innerSlotsUsed: itemTouched.size,
  };
};

/**
 * DFS subset enumeration with cap-violation pruning. Yields every valid
 * `BinShape` (size 1..|R|) that fits within `facility.capabilities`.
 *
 * Pruning: at each step we extend the current subset by adding a recipe
 * whose index is greater than the last (combinations, not permutations)
 * AND whose addition keeps `union of items ≤ innerSlots`. We always
 * verify port caps via `buildBinShape` since net I/O can only be
 * computed once the full set is known (item production and consumption
 * across recipes can cancel).
 */
const enumerateBinShapes = (
  recipes: Recipe[],
  facility: Facility,
  itemMap: Map<ItemId, Item>,
): BinShape[] => {
  const caps = facility.capabilities;
  if (!caps || recipes.length === 0) return [];

  const shapes: BinShape[] = [];
  const itemsTouchedBy = recipes.map(
    (r) => new Set([...r.inputs.map((i) => i.itemId), ...r.outputs.map((o) => o.itemId)]),
  );
  const maxFormulas = caps.maxFormulas ?? recipes.length;

  const dfs = (
    startIdx: number,
    chosen: number[],
    unionItems: Set<ItemId>,
  ) => {
    if (chosen.length > 0) {
      const shape = buildBinShape(
        chosen.map((i) => recipes[i]),
        facility,
        itemMap,
      );
      if (shape) shapes.push(shape);
    }
    if (chosen.length >= maxFormulas) return;

    for (let i = startIdx; i < recipes.length; i++) {
      const itemsAfter = new Set(unionItems);
      for (const id of itemsTouchedBy[i]) itemsAfter.add(id);
      if (itemsAfter.size > caps.innerSlots) continue;
      chosen.push(i);
      dfs(i + 1, chosen, itemsAfter);
      chosen.pop();
    }
  };

  dfs(0, [], new Set());
  return shapes;
};

/**
 * Build the recipe-pool used by Phase 3: every distinct recipe that
 * either has positive Phase 2 slot demand OR is an equivalent (same
 * signature) twin of one that does.
 *
 * Twins matter because Phase 2's LP picks one variant of each pool
 * recipe (typically `_1` for power minimisation pre-grouping), but
 * Phase 3 should consider both `_1` and `_2` so it can pack into
 * Expanded Crucibles when beneficial.
 */
const buildEquivalenceClasses = (
  recipeSlotDemands: Map<RecipeId, number>,
  recipeMap: Map<RecipeId, Recipe>,
): Array<{
  slotDemand: number;
  alternatives: Recipe[];
  canonicalRecipe: Recipe;
  /** Per-original-demand-recipe slot count, used by allocator to key
   * allocations by Phase 2's recipe id (not the physical twin chosen
   * by the ILP). */
  demandByRecipeId: Map<RecipeId, number>;
}> => {
  const allRecipes = Array.from(recipeMap.values());
  const visitedSignatures = new Map<string, number>(); // sig → class index
  const classes: Array<{
    slotDemand: number;
    alternatives: Recipe[];
    canonicalRecipe: Recipe;
    demandByRecipeId: Map<RecipeId, number>;
  }> = [];

  for (const [recipeId, slotDemand] of recipeSlotDemands.entries()) {
    if (slotDemand <= SLOT_DEMAND_EPSILON) continue;
    const canonical = recipeMap.get(recipeId);
    if (!canonical) continue;
    const sig = recipeSignature(canonical);
    const existingIdx = visitedSignatures.get(sig);
    if (existingIdx !== undefined) {
      const cls = classes[existingIdx];
      cls.slotDemand += slotDemand;
      cls.demandByRecipeId.set(recipeId, slotDemand);
      continue;
    }
    visitedSignatures.set(sig, classes.length);
    classes.push({
      slotDemand,
      alternatives: findRecipeAlternatives(canonical, allRecipes),
      canonicalRecipe: canonical,
      demandByRecipeId: new Map([[recipeId, slotDemand]]),
    });
  }
  return classes;
};

/** Stable bin id derived from facility, recipe ids, and emit index. */
const makeBinId = (
  facilityId: FacilityId,
  recipeIds: RecipeId[],
  index: number,
): string => `bin-${facilityId}-${recipeIds.join("-")}-${index}`;

/**
 * Solve the integer LP that packs slot demands into bins.
 *
 * Variables: one integer `x_t ≥ 0` per `BinShape`.
 * Constraints: for each equivalence class (set of substitutable recipes),
 *   `Σ_{t containing any class member} x_t ≥ totalSlotDemand`.
 * Lex pass 1 minimises total buildings. Pass 2 minimises power among
 * building-optimal solutions.
 */
type SolveOutput = {
  shapeCounts: Map<BinShape, number>;
  totalBuildings: number;
  totalPower: number;
};

const solvePacking = (
  shapes: BinShape[],
  classes: Array<{
    slotDemand: number;
    alternatives: Recipe[];
    canonicalRecipe: Recipe;
    demandByRecipeId: Map<RecipeId, number>;
  }>,
  recipeOverrides: Map<ItemId, RecipeId> | undefined,
  recipeMap: Map<RecipeId, Recipe>,
): SolveOutput | null => {
  if (shapes.length === 0 || classes.length === 0) {
    return { shapeCounts: new Map(), totalBuildings: 0, totalPower: 0 };
  }

  // Map var-name → BinShape (order-stable).
  const shapeByVar = new Map<string, BinShape>();
  shapes.forEach((s, i) => shapeByVar.set(`x_${i}`, s));

  // Build equivalence-class membership: for each class, the set of bin
  // shape indices containing any class-member recipe.
  const classMembership: Array<{
    name: string;
    rhs: number;
    shapeIdxs: number[];
    classIdx: number;
  }> = classes.map((cls, classIdx) => {
    const allowedRecipeIds = new Set<RecipeId>();
    for (const r of cls.alternatives) allowedRecipeIds.add(r.id);
    // Recipe-override pinning: if any item's override pins a specific
    // variant of this class, only that variant is allowed.
    if (recipeOverrides) {
      for (const [, overrideRecipeId] of recipeOverrides.entries()) {
        const overrideRecipe = recipeMap.get(overrideRecipeId);
        if (!overrideRecipe) continue;
        if (recipeSignature(overrideRecipe) === recipeSignature(cls.canonicalRecipe)) {
          allowedRecipeIds.clear();
          allowedRecipeIds.add(overrideRecipeId);
        }
      }
    }
    const shapeIdxs: number[] = [];
    shapes.forEach((shape, idx) => {
      for (const rid of shape.recipeIds) {
        if (allowedRecipeIds.has(rid)) {
          shapeIdxs.push(idx);
          return;
        }
      }
    });
    return {
      name: `cls_${classIdx}`,
      rhs: cls.slotDemand,
      shapeIdxs,
      classIdx,
    };
  });

  // If any class has no shapes (e.g. due to an over-restrictive override
  // making all alternatives invalid), packing is infeasible.
  for (const cm of classMembership) {
    if (cm.shapeIdxs.length === 0) return null;
  }

  type Model = {
    optimize: string;
    opType: "min";
    constraints: Record<string, { min?: number; max?: number; equal?: number }>;
    variables: Record<string, Record<string, number>>;
    ints: Record<string, 1>;
  };

  const variables: Model["variables"] = {};
  const ints: Model["ints"] = {};
  shapes.forEach((shape, idx) => {
    const varName = `x_${idx}`;
    const coefs: Record<string, number> = {
      buildings: 1,
      power: shape.facility.powerConsumption,
    };
    variables[varName] = coefs;
    ints[varName] = 1;
  });
  for (const cm of classMembership) {
    for (const idx of cm.shapeIdxs) {
      variables[`x_${idx}`][cm.name] = 1;
    }
  }

  const constraints: Model["constraints"] = {};
  for (const cm of classMembership) {
    constraints[cm.name] = { min: cm.rhs };
  }

  // Pass 1: minimise total buildings.
  const passOne: Model = {
    optimize: "buildings",
    opType: "min",
    constraints,
    variables,
    ints,
  };
  let r1: Record<string, number | boolean | undefined>;
  try {
    r1 = solver.Solve(passOne) as Record<string, number | boolean | undefined>;
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.warn("[CRUCIBLE_PACKING] pass-1 solver threw:", e);
    }
    return null;
  }
  if (r1.feasible !== true || r1.bounded === false) return null;

  const buildingsOpt = r1.result as number;

  // Pass 2: minimise power subject to total buildings ≤ pass-1 optimum.
  const passTwo: Model = {
    optimize: "power",
    opType: "min",
    constraints: {
      ...constraints,
      buildings_cap: { max: buildingsOpt + LEX_BUILDINGS_TOLERANCE },
    },
    variables: {},
    ints,
  };
  for (const [varName, coefs] of Object.entries(variables)) {
    passTwo.variables[varName] = { ...coefs, buildings_cap: 1 };
  }
  let r2: Record<string, number | boolean | undefined>;
  try {
    r2 = solver.Solve(passTwo) as Record<string, number | boolean | undefined>;
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.warn("[CRUCIBLE_PACKING] pass-2 solver threw:", e);
    }
    // Fall back to pass-1 result.
    r2 = r1;
  }
  if (r2.feasible !== true || r2.bounded === false) {
    if (import.meta.env?.DEV) {
      console.warn(
        "[CRUCIBLE_PACKING] pass-2 infeasible/unbounded, falling back to pass-1",
      );
    }
    r2 = r1;
  }

  const shapeCounts = new Map<BinShape, number>();
  let totalBuildings = 0;
  let totalPower = 0;
  for (const [varName, shape] of shapeByVar.entries()) {
    const v = r2[varName];
    if (typeof v !== "number") continue;
    const count = Math.round(v);
    if (count <= 0) continue;
    shapeCounts.set(shape, count);
    totalBuildings += count;
    totalPower += count * shape.facility.powerConsumption;
  }

  return { shapeCounts, totalBuildings, totalPower };
};

/**
 * Distribute slot demand across chosen bins using a greedy fill.
 *
 * Allocations are keyed by **demand recipe id** (the recipe id the
 * caller passed in via `recipeSlotDemands`, i.e. Phase 2's pick) — not
 * by the physical variant the ILP packed into the bin. This decouples
 * Phase 3's output from Phase 2's recipe choice: e.g. the LP may have
 * picked `lx_1` (Reactor variant) but Phase 3 may pack into a bin of
 * `lx_2` (Expanded twin). The allocation entry under `lx_1` correctly
 * reports the demand as satisfied; the bin's `recipeIds` reflects the
 * physical variant.
 *
 * Each building of a bin provides 1 slot of EACH of its constituent
 * recipes per cycle. Per-bin per-recipe budgets are tracked
 * independently so different classes drain different budgets.
 */
const allocateSlotsToBins = (
  shapeCounts: Map<BinShape, number>,
  classes: Array<{ slotDemand: number; alternatives: Recipe[]; canonicalRecipe: Recipe; demandByRecipeId: Map<RecipeId, number> }>,
  recipeMap: Map<RecipeId, Recipe>,
  itemMap: Map<ItemId, Item>,
): { bins: CrucibleBin[]; allocations: Map<RecipeId, RecipeBinAllocation> } => {
  // Materialise bins (one per shape, with buildingCount).
  const bins: CrucibleBin[] = [];
  const shapeBinId = new Map<BinShape, string>();
  let emitIdx = 0;
  // Sort shapes deterministically: facility id, then size desc, then recipe ids.
  const sortedShapes = Array.from(shapeCounts.keys()).sort((a, b) => {
    if (a.facility.id !== b.facility.id) {
      return a.facility.id < b.facility.id ? -1 : 1;
    }
    if (a.recipeIds.length !== b.recipeIds.length) {
      return b.recipeIds.length - a.recipeIds.length;
    }
    const aKey = a.recipeIds.join(",");
    const bKey = b.recipeIds.join(",");
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  for (const shape of sortedShapes) {
    const count = shapeCounts.get(shape) ?? 0;
    if (count <= 0) continue;
    const id = makeBinId(shape.facility.id, shape.recipeIds, emitIdx++);
    shapeBinId.set(shape, id);
    bins.push({
      id,
      facilityId: shape.facility.id,
      recipeIds: shape.recipeIds,
      buildingCount: count,
      // Scale net I/O by buildingCount (per-slot rate × number of buildings = total bin rate).
      externalInputs: shape.netInputs.map((io) => ({
        itemId: io.itemId,
        rate: io.rate * count,
        isLiquid: io.isLiquid,
      })),
      externalOutputs: shape.netOutputs.map((io) => ({
        itemId: io.itemId,
        rate: io.rate * count,
        isLiquid: io.isLiquid,
      })),
      internalItems: shape.internalItems,
      innerSlotsUsed: shape.innerSlotsUsed,
      isGrouped: shape.recipeIds.length >= 2,
    });
  }

  // Per equivalence class, allocate slot demand to bins greedily.
  // Each building of a bin provides 1 slot of EACH constituent recipe per
  // cycle, so per-bin capacity is tracked PER recipe (not as a shared total
  // across constituents). Classes drain only the budget for their member
  // recipes, leaving other constituents' budgets untouched.
  type AllocEntry = { recipeId: RecipeId; binId: string; slots: number };
  const allocEntries: AllocEntry[] = [];
  const remainingPerBinPerRecipe = new Map<string, Map<RecipeId, number>>();
  for (const bin of bins) {
    const perRecipe = new Map<RecipeId, number>();
    for (const rid of bin.recipeIds) perRecipe.set(rid, bin.buildingCount);
    remainingPerBinPerRecipe.set(bin.id, perRecipe);
  }

  for (const cls of classes) {
    const allowed = new Set(cls.alternatives.map((r) => r.id));
    // Iterate over each demand recipe in this class, draining its
    // demand from bins. We key allocations by the original demand
    // recipe id so downstream consumers can locate Phase-2's nodes.
    for (const [demandRecipeId, demand] of cls.demandByRecipeId.entries()) {
      let remaining = demand;
      for (const bin of bins) {
        if (remaining <= SLOT_DEMAND_EPSILON) break;
        const memberRecipeId = bin.recipeIds.find((rid) => allowed.has(rid));
        if (!memberRecipeId) continue;
        const perRecipe = remainingPerBinPerRecipe.get(bin.id)!;
        const cap = perRecipe.get(memberRecipeId) ?? 0;
        if (cap <= SLOT_DEMAND_EPSILON) continue;
        const take = Math.min(cap, remaining);
        perRecipe.set(memberRecipeId, cap - take);
        remaining -= take;
        allocEntries.push({ recipeId: demandRecipeId, binId: bin.id, slots: take });
      }
    }
  }

  // Build allocation map (keyed by demand recipe id).
  const allocations = new Map<RecipeId, RecipeBinAllocation>();
  for (const e of allocEntries) {
    let cur = allocations.get(e.recipeId);
    if (!cur) {
      cur = { recipeId: e.recipeId, totalSlots: 0, perBin: [] };
      allocations.set(e.recipeId, cur);
    }
    cur.totalSlots += e.slots;
    cur.perBin.push({ binId: e.binId, slots: e.slots });
  }

  // Defensive: items unused in shapes but present in itemMap don't affect
  // anything here; itemMap is only used by enumeration. (Keep parameter
  // for symmetry with future enhancements.)
  void recipeMap;
  void itemMap;

  return { bins, allocations };
};

/**
 * Emit trivial singleton bins for non-multi-formula recipes. This keeps
 * downstream consumers' data shape uniform: every active recipe has at
 * least one bin in the output.
 */
const emitSingletonBins = (
  recipeSlotDemands: Map<RecipeId, number>,
  packedAllocations: Map<RecipeId, RecipeBinAllocation>,
  recipeMap: Map<RecipeId, Recipe>,
  facilityMap: Map<FacilityId, Facility>,
  itemMap: Map<ItemId, Item>,
): { bins: CrucibleBin[]; allocations: Map<RecipeId, RecipeBinAllocation> } => {
  const bins: CrucibleBin[] = [];
  const allocations = new Map<RecipeId, RecipeBinAllocation>();
  let idx = 0;

  for (const [recipeId, slotDemand] of recipeSlotDemands.entries()) {
    if (slotDemand <= SLOT_DEMAND_EPSILON) continue;
    if (packedAllocations.has(recipeId)) continue;
    const recipe = recipeMap.get(recipeId);
    if (!recipe) continue;
    const facility = facilityMap.get(recipe.facilityId);
    if (!facility) continue;

    const inputs = recipe.inputs.map((i) => ({
      itemId: i.itemId,
      rate: calcRate(i.amount, recipe.craftingTime) * slotDemand,
      isLiquid: itemMap.get(i.itemId)?.isLiquid ?? false,
    }));
    const outputs = recipe.outputs.map((o) => ({
      itemId: o.itemId,
      rate: calcRate(o.amount, recipe.craftingTime) * slotDemand,
      isLiquid: itemMap.get(o.itemId)?.isLiquid ?? false,
    }));
    const innerSlotsUsed =
      new Set([...recipe.inputs.map((i) => i.itemId), ...recipe.outputs.map((o) => o.itemId)])
        .size;

    const id = makeBinId(facility.id, [recipeId], idx++);
    bins.push({
      id,
      facilityId: facility.id,
      recipeIds: [recipeId],
      buildingCount: slotDemand,
      externalInputs: inputs,
      externalOutputs: outputs,
      internalItems: [],
      innerSlotsUsed,
      isGrouped: false,
    });
    allocations.set(recipeId, {
      recipeId,
      totalSlots: slotDemand,
      perBin: [{ binId: id, slots: slotDemand }],
    });
  }

  return { bins, allocations };
};

/**
 * Phase 3 entry point. Returns bins + per-recipe allocations.
 */
export const packCrucibleBins = (input: PackingInput): PackingResult => {
  const { recipeSlotDemands, recipeMap, facilityMap, itemMap, recipeOverrides } =
    input;

  // Identify which recipes are eligible for multi-formula packing
  // (their facility has `capabilities`).
  const eligibleRecipeIds = new Set<RecipeId>();
  const eligibleFacilities = new Set<Facility>();
  for (const [recipeId, slotDemand] of recipeSlotDemands.entries()) {
    if (slotDemand <= SLOT_DEMAND_EPSILON) continue;
    const recipe = recipeMap.get(recipeId);
    if (!recipe) continue;
    const facility = facilityMap.get(recipe.facilityId);
    if (!facility?.capabilities) continue;
    eligibleRecipeIds.add(recipeId);
    eligibleFacilities.add(facility);
    // Twins on other facilities (different facility, same signature) also
    // become candidates.
    for (const r of recipeMap.values()) {
      if (recipeSignature(r) !== recipeSignature(recipe)) continue;
      const f = facilityMap.get(r.facilityId);
      if (f?.capabilities) eligibleFacilities.add(f);
    }
  }

  // Build equivalence classes (one per recipe-signature with positive
  // demand). Each class accumulates slot demand from all twins.
  const classes = buildEquivalenceClasses(
    new Map([...recipeSlotDemands.entries()].filter(([rid]) => eligibleRecipeIds.has(rid))),
    recipeMap,
  );

  // Enumerate bin shapes per facility. The shape's recipes must come
  // from the union of class alternatives that the facility hosts.
  const classRecipeIdsByFacility = new Map<FacilityId, Recipe[]>();
  for (const facility of eligibleFacilities) {
    const recipesOnThisFacility: Recipe[] = [];
    for (const cls of classes) {
      for (const r of cls.alternatives) {
        if (r.facilityId === facility.id) {
          recipesOnThisFacility.push(r);
          break;
        }
      }
    }
    classRecipeIdsByFacility.set(facility.id, recipesOnThisFacility);
  }

  const allShapes: BinShape[] = [];
  for (const facility of eligibleFacilities) {
    const recipesOnFac = classRecipeIdsByFacility.get(facility.id) ?? [];
    const shapes = enumerateBinShapes(recipesOnFac, facility, itemMap);
    allShapes.push(...shapes);
  }

  if (import.meta.env?.DEV) {
    console.log(
      `[CRUCIBLE_PACKING] Enumerated ${allShapes.length} bin shapes across ${eligibleFacilities.size} facilities`,
    );
  }

  const solution = solvePacking(allShapes, classes, recipeOverrides, recipeMap);
  if (!solution) {
    if (import.meta.env?.DEV) {
      console.warn(
        "[CRUCIBLE_PACKING] ILP failed; falling back to all-singleton bins",
      );
    }
    return emitSingletonBins(
      recipeSlotDemands,
      new Map(),
      recipeMap,
      facilityMap,
      itemMap,
    );
  }

  if (import.meta.env?.DEV) {
    console.log(
      `[CRUCIBLE_PACKING] Solved: ${solution.totalBuildings} buildings, ${solution.totalPower}W`,
    );
  }

  const packed = allocateSlotsToBins(
    solution.shapeCounts,
    classes,
    recipeMap,
    itemMap,
  );
  const singletons = emitSingletonBins(
    recipeSlotDemands,
    packed.allocations,
    recipeMap,
    facilityMap,
    itemMap,
  );

  return {
    bins: [...packed.bins, ...singletons.bins],
    allocations: new Map([...packed.allocations, ...singletons.allocations]),
  };
};
