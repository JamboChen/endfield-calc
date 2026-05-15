/**
 * Phase 3: pack multi-formula facility recipes into shared buildings.
 *
 * Given Phase 2's per-recipe slot demands (`recipeFacilityCounts`), this
 * module decides how those slots are physically realised. For multi-formula
 * facilities (those with `cacheSlots` defined), multiple recipes may share
 * a single building, sharing inner-slot inventory and external port
 * budget. Each "bin" of buildings has the same recipe configuration;
 * each building of that bin provides 1 slot of each constituent recipe
 * per cycle.
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
 *   4. Emit `Bin[]` with per-bin net I/O metadata, plus a
 *      per-recipe `RecipeBinAllocation` distributing slot demand across
 *      the chosen bins.
 *
 * Recipes hosted by single-formula facilities (no `cacheSlots`) produce
 * a trivial singleton bin per recipe so downstream consumers always see
 * a uniform data shape.
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
  Bin,
  RecipeBinAllocation,
} from "@/types";

/** Numerical tolerance below which net flow is treated as zero (fully internal). */
const NET_FLOW_EPSILON = 1e-9;

/** Tolerance for treating slot demands as zero. Mirrors `LP_EPSILON` in lp-solver. */
const SLOT_DEMAND_EPSILON = 1e-9;

/** Building-count slack added to lex pass 2's cap to absorb LP noise. */
const LEX_BUILDINGS_TOLERANCE = 1e-6;

/**
 * Power-budget slack added to lex pass 3's cap to absorb LP noise.
 * Generous (1e-3) relative to typical power values (multiples of 50W or
 * 100W per building) so rounding noise doesn't accidentally exclude a
 * legitimately optimal pass-3 packing. Tight enough that pass 3 can't
 * swap a higher-power facility tier under the cap.
 */
const LEX_POWER_TOLERANCE = 1e-3;

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
  bins: Bin[];
  allocations: Map<RecipeId, RecipeBinAllocation>;
  /**
   * Non-fatal warnings surfaced from packing. Populated when a recipe
   * override pinned a variant whose facility has no valid bin shape
   * (forcing the packer to fall back to per-recipe singletons), or
   * other override-related diagnostics worth surfacing to the user.
   */
  warnings: string[];
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
 * combination violates the facility's inner-slot or port budget.
 *
 * Distinct-item port caps are derived from buffer counts:
 *   - liquid-in  = `buffersIn.pipe.length`
 *   - liquid-out = `buffersOut.pipe.length`
 *   - belt-out   = `buffersOut.belt.length`
 *
 * Belt-input variety is intentionally uncapped wrt bin packing; throughput
 * is validated separately during post-pass.
 */
const buildBinShape = (
  recipes: Recipe[],
  facility: Facility,
  itemMap: Map<ItemId, Item>,
): BinShape | null => {
  const innerSlots = facility.cacheSlots;
  if (innerSlots == null) return null;

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

  if (itemTouched.size > innerSlots) return null;

  const netInputs: BinShape["netInputs"] = [];
  const netOutputs: BinShape["netOutputs"] = [];
  const internalItems: ItemId[] = [];

  let liquidIn = 0;
  let liquidOut = 0;
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
    } else {
      netOutputs.push({ itemId, rate: net, isLiquid });
      if (isLiquid) liquidOut += 1;
      else beltOut += 1;
    }
  }

  if (liquidIn > facility.buffersIn.pipe.length) return null;
  if (liquidOut > facility.buffersOut.pipe.length) return null;
  if (beltOut > facility.buffersOut.belt.length) return null;

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
 * `BinShape` (size 1..|R|) that fits within the facility's inner-slot
 * and port budget.
 *
 * Pruning: at each step we extend the current subset by adding a recipe
 * whose index is greater than the last (combinations, not permutations)
 * AND whose addition keeps `union of items ≤ cacheSlots`. We always
 * verify port caps via `buildBinShape` since net I/O can only be
 * computed once the full set is known (item production and consumption
 * across recipes can cancel).
 */
const enumerateBinShapes = (
  recipes: Recipe[],
  facility: Facility,
  itemMap: Map<ItemId, Item>,
): BinShape[] => {
  const innerSlots = facility.cacheSlots;
  if (innerSlots == null || recipes.length === 0) return [];

  const shapes: BinShape[] = [];
  const itemsTouchedBy = recipes.map(
    (r) => new Set([...r.inputs.map((i) => i.itemId), ...r.outputs.map((o) => o.itemId)]),
  );

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

    for (let i = startIdx; i < recipes.length; i++) {
      const itemsAfter = new Set(unionItems);
      for (const id of itemsTouchedBy[i]) itemsAfter.add(id);
      if (itemsAfter.size > innerSlots) continue;
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
 * the larger variant when beneficial.
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
): SolveOutput | null => {
  if (shapes.length === 0 || classes.length === 0) {
    return { shapeCounts: new Map(), totalBuildings: 0, totalPower: 0 };
  }

  // Map var-name → BinShape (order-stable).
  const shapeByVar = new Map<string, BinShape>();
  shapes.forEach((s, i) => shapeByVar.set(`x_${i}`, s));

  // Build LP constraints per equivalence class. The formulation has two
  // levels of constraints per class:
  //
  //   1. **Per-pin restricted** (one per pinned demand-recipe in the
  //      class): `Σ_{shapes containing pin} x_t ≥ pin_demand`. Forces
  //      the ILP to build enough facility-restricted shapes to cover
  //      the demand attributable to each user-pinned variant.
  //   2. **Class-wide total** (one per class): `Σ_{any class shape} x_t
  //      ≥ Σ_demands_in_class`. Ensures the total slot supply across
  //      the class meets total demand. Shapes serving a pin also count
  //      toward the total — the LP can pack pinned-only or
  //      pinned+substitute as it prefers (subject to lex passes).
  //
  // The split honours per-pin user intent (e.g. "tier-1 facility for
  // item_a, tier-2 facility for item_b" when items share an equivalence
  // class) instead of collapsing all demand onto the last-iterated pin,
  // while preserving free substitution among non-pinned demand for the
  // common no-conflict case.
  //
  // A demand-recipe is "pinned" iff some `recipeOverrides` entry's
  // recipe id equals it. The override key (which item the user pinned)
  // doesn't matter — only the chosen recipe variant.
  const classMembership: Array<{
    name: string;
    rhs: number;
    shapeIdxs: number[];
    classIdx: number;
  }> = [];

  classes.forEach((cls, classIdx) => {
    const classRecipeIds = new Set<RecipeId>(cls.alternatives.map((r) => r.id));

    // Identify demand-recipes that are pinned by any user override.
    const pinnedDemandIds = new Set<RecipeId>();
    if (recipeOverrides) {
      for (const overrideRecipeId of recipeOverrides.values()) {
        if (cls.demandByRecipeId.has(overrideRecipeId)) {
          pinnedDemandIds.add(overrideRecipeId);
        }
      }
    }

    // Per-pin restricted constraint.
    for (const pinId of pinnedDemandIds) {
      const pinDemand = cls.demandByRecipeId.get(pinId) ?? 0;
      if (pinDemand <= SLOT_DEMAND_EPSILON) continue;
      const shapeIdxs: number[] = [];
      shapes.forEach((shape, idx) => {
        if (shape.recipeIds.includes(pinId)) shapeIdxs.push(idx);
      });
      classMembership.push({
        name: `cls_${classIdx}_pin_${pinId}`,
        rhs: pinDemand,
        shapeIdxs,
        classIdx,
      });
    }

    // Class-wide total constraint.
    const totalShapeIdxs: number[] = [];
    shapes.forEach((shape, idx) => {
      for (const rid of shape.recipeIds) {
        if (classRecipeIds.has(rid)) {
          totalShapeIdxs.push(idx);
          return;
        }
      }
    });
    classMembership.push({
      name: `cls_${classIdx}_total`,
      rhs: cls.slotDemand,
      shapeIdxs: totalShapeIdxs,
      classIdx,
    });
  });

  // If any constraint has no shapes (e.g. a pin restricts to a recipe
  // with no valid shape on its facility, or a class has no shapes at
  // all), packing is infeasible.
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
      console.warn("[BIN_PACKING] pass-1 solver threw:", e);
    }
    return null;
  }
  if (r1.feasible !== true || r1.bounded === false) return null;

  if (typeof r1.result !== "number" || !Number.isFinite(r1.result)) {
    if (import.meta.env?.DEV) {
      console.warn(
        "[BIN_PACKING] pass-1 returned a non-finite objective; aborting",
        r1.result,
      );
    }
    return null;
  }
  const buildingsOpt = r1.result;

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
  let pass2Succeeded = true;
  try {
    r2 = solver.Solve(passTwo) as Record<string, number | boolean | undefined>;
  } catch (e) {
    if (import.meta.env?.DEV) {
      console.warn("[BIN_PACKING] pass-2 solver threw:", e);
    }
    // Fall back to pass-1 result.
    r2 = r1;
    pass2Succeeded = false;
  }
  if (r2.feasible !== true || r2.bounded === false) {
    if (import.meta.env?.DEV) {
      console.warn(
        "[BIN_PACKING] pass-2 infeasible/unbounded, falling back to pass-1",
      );
    }
    r2 = r1;
    pass2Succeeded = false;
  }

  // Pass 3: minimise Σ x_t × |recipes_in_shape_t|, subject to building +
  // power caps from prior passes. Equivalent (up to a constant) to
  // minimising total over-provisioning Σ(allocated_slots − demand). Breaks
  // ties between equally-priced packings that differ in shape distribution
  // — e.g. for Xircon target=57, prefers `2×{LX,XE,X} + 2×{LX,XE}` (sum
  // 10) over `3×{LX,XE,X} + 1×{LX,XE}` (sum 11), eliminating the
  // "idle X slot in building 3 of an {LX,XE,X} bin" artefact. Both
  // packings cost 4 buildings @ 400W, so pass 1 and pass 2 tie.
  //
  // Only runs if pass 2 succeeded — otherwise r2 is r1 and there's no
  // meaningful power cap to enforce.
  let finalResult = r2;
  if (
    pass2Succeeded &&
    typeof r2.result === "number" &&
    Number.isFinite(r2.result)
  ) {
    const powerOpt = r2.result;
    const passThree: Model = {
      optimize: "shape_size",
      opType: "min",
      constraints: {
        ...constraints,
        buildings_cap: { max: buildingsOpt + LEX_BUILDINGS_TOLERANCE },
        power_cap: { max: powerOpt + LEX_POWER_TOLERANCE },
      },
      variables: {},
      ints,
    };
    for (const [varName, coefs] of Object.entries(variables)) {
      const shape = shapeByVar.get(varName);
      const shapeSize = shape ? shape.recipeIds.length : 0;
      passThree.variables[varName] = {
        ...coefs,
        buildings_cap: 1,
        power_cap: coefs.power,
        shape_size: shapeSize,
      };
    }
    let r3: Record<string, number | boolean | undefined>;
    try {
      r3 = solver.Solve(passThree) as Record<string, number | boolean | undefined>;
    } catch (e) {
      if (import.meta.env?.DEV) {
        console.warn(
          "[BIN_PACKING] pass-3 solver threw, falling back to pass-2:",
          e,
        );
      }
      r3 = r2;
    }
    if (r3.feasible !== true || r3.bounded === false) {
      if (import.meta.env?.DEV) {
        console.warn(
          `[BIN_PACKING] pass-3 ${r3.bounded === false ? "unbounded" : "infeasible"} after lex caps; falling back to pass-2`,
        );
      }
      r3 = r2;
    }
    finalResult = r3;
  }

  const shapeCounts = new Map<BinShape, number>();
  let totalBuildings = 0;
  let totalPower = 0;
  for (const [varName, shape] of shapeByVar.entries()) {
    const v = finalResult[varName];
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
 * Distribute slot demand across chosen bins using a greedy fill, then
 * materialise `Bin[]` with bin.recipeIds rewritten to **demand
 * recipe ids** (Phase 2's pick) — not the physical twin variant the ILP
 * packed.
 *
 * The demand-id rewrite is the central correctness fix: downstream
 * consumers (calculator graph, mappers, table) only have access to
 * Phase 2's recipe ids. They compare against `bin.recipeIds` for
 * sister-filtering, primary-row determination, and internal-edge
 * tagging. Storing physical ids here would silently break every such
 * comparison whenever Phase 3 swaps variants (e.g. demand on `lx_1`
 * but bin physically runs `lx_2` on Expanded). The bin's
 * `facilityId` separately records the physical facility for power /
 * building-count purposes — that's the only thing that needs to be
 * physical.
 *
 * Each building of a bin provides 1 slot of EACH of its constituent
 * recipes per cycle. Per-bin per-recipe budgets are tracked
 * independently so different classes drain different budgets.
 *
 * **Active-rate I/O**: bin external I/O is computed from the per-bin
 * per-recipe ACTIVE slot count (= sum of slots the greedy allocator
 * drained into this bin for each recipe), NOT from
 * `shape.netOutputs × buildingCount`. The difference matters when a
 * recipe's Phase 2 demand is less than the bin's `buildingCount` (e.g.
 * Xircon at target=57: bin `{LX, XE, X}` × 2 hosts LX/XE at full and X
 * at 1.9 of 2 slots). At full-capacity the X-Sewage cycle nets to zero;
 * at active rate X under-produces Sewage and the bin shows Sewage as a
 * small external input. This matches Phase 2's mass-balance plan
 * exactly, and lets the merged bin card display the actual production
 * rate (matching what Recipe view shows) instead of theoretical
 * full-capacity.
 */
const allocateSlotsToBins = (
  shapeCounts: Map<BinShape, number>,
  classes: Array<{ slotDemand: number; alternatives: Recipe[]; canonicalRecipe: Recipe; demandByRecipeId: Map<RecipeId, number> }>,
  recipeMap: Map<RecipeId, Recipe>,
  itemMap: Map<ItemId, Item>,
  recipeOverrides: Map<ItemId, RecipeId> | undefined,
): { bins: Bin[]; allocations: Map<RecipeId, RecipeBinAllocation> } => {
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

  // Per equivalence class, allocate slot demand to physical-recipe slot
  // budgets within bins. Each building of a bin provides 1 slot of EACH
  // constituent recipe per cycle; classes drain only the budget for
  // their member recipes, leaving other constituents' budgets untouched.
  type AllocEntry = {
    /** Demand recipe id (Phase 2's pick) — keys the allocation map. */
    demandRecipeId: RecipeId;
    /** Physical recipe id picked by ILP — used to dedupe co-locations. */
    physicalRecipeId: RecipeId;
    binId: string;
    slots: number;
  };
  const allocEntries: AllocEntry[] = [];

  // Map shape → tentative bin id (assigned in deterministic order).
  const shapeIdByPosition: string[] = [];
  sortedShapes.forEach((shape, idx) => {
    const count = shapeCounts.get(shape) ?? 0;
    if (count <= 0) return;
    shapeIdByPosition[idx] = makeBinId(shape.facility.id, shape.recipeIds, idx);
  });

  // Per-bin, per-physical-recipe slot budget.
  const remainingPerBinPerRecipe = new Map<string, Map<RecipeId, number>>();
  sortedShapes.forEach((shape, idx) => {
    const count = shapeCounts.get(shape) ?? 0;
    if (count <= 0) return;
    const binId = shapeIdByPosition[idx];
    const perRecipe = new Map<RecipeId, number>();
    for (const rid of shape.recipeIds) perRecipe.set(rid, count);
    remainingPerBinPerRecipe.set(binId, perRecipe);
  });

  // For each class, identify pinned demand-recipes (those referenced by
  // any user override). Pinned demand-recipes are restricted to shapes
  // containing the pin itself — they cannot substitute through other
  // class members. Unpinned demand-recipes accept any class member.
  //
  // Pinned demands are allocated first so they claim restricted shapes
  // before unpinned demands can substitute into them. Within each
  // tier (pinned/unpinned), demand-recipe ids sort alphabetically for
  // determinism.
  for (const cls of classes) {
    const classRecipeIds = new Set<RecipeId>(cls.alternatives.map((r) => r.id));
    const pinnedDemandIds = new Set<RecipeId>();
    if (recipeOverrides) {
      for (const overrideRecipeId of recipeOverrides.values()) {
        if (cls.demandByRecipeId.has(overrideRecipeId)) {
          pinnedDemandIds.add(overrideRecipeId);
        }
      }
    }

    const sortedDemands = [...cls.demandByRecipeId.entries()].sort(
      ([a], [b]) => {
        const aPinned = pinnedDemandIds.has(a);
        const bPinned = pinnedDemandIds.has(b);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
      },
    );

    for (const [demandRecipeId, demand] of sortedDemands) {
      const allowed = pinnedDemandIds.has(demandRecipeId)
        ? new Set<RecipeId>([demandRecipeId])
        : classRecipeIds;
      let remaining = demand;
      sortedShapes.forEach((shape, idx) => {
        if (remaining <= SLOT_DEMAND_EPSILON) return;
        const count = shapeCounts.get(shape) ?? 0;
        if (count <= 0) return;
        const binId = shapeIdByPosition[idx];
        const memberRecipeId = shape.recipeIds.find((rid) => allowed.has(rid));
        if (!memberRecipeId) return;
        const perRecipe = remainingPerBinPerRecipe.get(binId)!;
        const cap = perRecipe.get(memberRecipeId) ?? 0;
        if (cap <= SLOT_DEMAND_EPSILON) return;
        const take = Math.min(cap, remaining);
        perRecipe.set(memberRecipeId, cap - take);
        remaining -= take;
        allocEntries.push({
          demandRecipeId,
          physicalRecipeId: memberRecipeId,
          binId,
          slots: take,
        });
      });
    }
  }

  // Materialise Bin[] with `recipeIds` populated from the demand
  // ids that allocate to this bin (sorted, deduped). Skip shapes with no
  // allocations (could happen if the ILP picked a shape but the greedy
  // allocator didn't drain anything into it — defensive only; should be
  // unreachable given that ILP shape counts equal slot supplies).
  const binDemandIds = new Map<string, Set<RecipeId>>();
  for (const e of allocEntries) {
    let s = binDemandIds.get(e.binId);
    if (!s) {
      s = new Set();
      binDemandIds.set(e.binId, s);
    }
    s.add(e.demandRecipeId);
  }

  // Per-bin per-physical-recipe ACTIVE slot count. Sum across allocEntries
  // because the greedy allocator may have produced multiple entries
  // targeting the same bin/recipe (when an equivalence class has multiple
  // demand-recipe ids draining to the same physical recipe in the same
  // bin).
  const activeSlotsByBin = new Map<string, Map<RecipeId, number>>();
  for (const e of allocEntries) {
    let m = activeSlotsByBin.get(e.binId);
    if (!m) {
      m = new Map();
      activeSlotsByBin.set(e.binId, m);
    }
    m.set(e.physicalRecipeId, (m.get(e.physicalRecipeId) ?? 0) + e.slots);
  }

  const bins: Bin[] = [];
  sortedShapes.forEach((shape, idx) => {
    const count = shapeCounts.get(shape) ?? 0;
    if (count <= 0) return;
    const binId = shapeIdByPosition[idx];
    const demandIds = Array.from(binDemandIds.get(binId) ?? []).sort();
    if (demandIds.length === 0) return;

    // Compute net I/O from ACTIVE per-recipe slot counts, not from
    // `shape.netOutputs × count`. When a recipe's Phase 2 demand is
    // smaller than the bin's per-recipe physical capacity (= count),
    // the recipe runs at partial load and its contribution scales
    // accordingly. Items that net to zero across these active flows are
    // classified as internal; positive → external output; negative →
    // external input. Mirrors `buildBinShape`'s classification logic at
    // the 1-slot-per-recipe enumeration step.
    const activeMap = activeSlotsByBin.get(binId) ?? new Map<RecipeId, number>();
    const netRates = new Map<ItemId, number>();
    for (const rid of shape.recipeIds) {
      const active = activeMap.get(rid) ?? 0;
      if (active <= 0) continue;
      const recipe = recipeMap.get(rid);
      if (!recipe) continue;
      for (const inp of recipe.inputs) {
        netRates.set(
          inp.itemId,
          (netRates.get(inp.itemId) ?? 0) -
            calcRate(inp.amount, recipe.craftingTime) * active,
        );
      }
      for (const out of recipe.outputs) {
        netRates.set(
          out.itemId,
          (netRates.get(out.itemId) ?? 0) +
            calcRate(out.amount, recipe.craftingTime) * active,
        );
      }
    }

    const externalInputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }> = [];
    const externalOutputs: Array<{ itemId: ItemId; rate: number; isLiquid: boolean }> = [];
    const internalItems: ItemId[] = [];
    for (const [itemId, net] of netRates.entries()) {
      const isLiquid = itemMap.get(itemId)?.isLiquid ?? false;
      if (Math.abs(net) <= NET_FLOW_EPSILON) {
        internalItems.push(itemId);
      } else if (net < 0) {
        externalInputs.push({ itemId, rate: -net, isLiquid });
      } else {
        externalOutputs.push({ itemId, rate: net, isLiquid });
      }
    }

    // Sort for determinism (mirrors buildBinShape).
    const byItemId = (a: { itemId: ItemId }, b: { itemId: ItemId }) =>
      a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
    externalInputs.sort(byItemId);
    externalOutputs.sort(byItemId);
    internalItems.sort();

    bins.push({
      id: binId,
      facilityId: shape.facility.id,
      recipeIds: demandIds,
      buildingCount: count,
      externalInputs,
      externalOutputs,
      internalItems,
      innerSlotsUsed: shape.innerSlotsUsed,
      // `isGrouped` reflects user-visible recipe count, not physical
      // shape size. In the theoretical case where a multi-formula shape
      // has only one demand class actually allocated, `isGrouped: false`
      // matches the bin's `recipeIds.length === 1` semantics.
      isGrouped: demandIds.length >= 2,
    });
  });

  // Build allocation map (keyed by demand recipe id).
  const allocations = new Map<RecipeId, RecipeBinAllocation>();
  for (const e of allocEntries) {
    let cur = allocations.get(e.demandRecipeId);
    if (!cur) {
      cur = { recipeId: e.demandRecipeId, totalSlots: 0, perBin: [] };
      allocations.set(e.demandRecipeId, cur);
    }
    cur.totalSlots += e.slots;
    cur.perBin.push({ binId: e.binId, slots: e.slots });
  }

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
): { bins: Bin[]; allocations: Map<RecipeId, RecipeBinAllocation> } => {
  const bins: Bin[] = [];
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
 * Identify recipe-override pins that have no valid bin shape on their
 * facility. These pins force `solvePacking` into infeasibility — the
 * packer falls back to per-recipe singletons, losing grouping
 * benefits. Returns a list of human-readable warning strings (one per
 * problematic pin) so the UI can surface them to the user.
 */
const buildInfeasiblePinWarnings = (
  recipeOverrides: Map<ItemId, RecipeId> | undefined,
  recipeSlotDemands: Map<RecipeId, number>,
  recipeMap: Map<RecipeId, Recipe>,
  facilityMap: Map<FacilityId, Facility>,
  itemMap: Map<ItemId, Item>,
): string[] => {
  if (!recipeOverrides || recipeOverrides.size === 0) return [];
  const warnings: string[] = [];
  const seenPins = new Set<RecipeId>();

  for (const overrideRecipeId of recipeOverrides.values()) {
    if (seenPins.has(overrideRecipeId)) continue;
    seenPins.add(overrideRecipeId);
    if ((recipeSlotDemands.get(overrideRecipeId) ?? 0) <= SLOT_DEMAND_EPSILON) {
      continue;
    }
    const recipe = recipeMap.get(overrideRecipeId);
    if (!recipe) continue;
    const facility = facilityMap.get(recipe.facilityId);
    // Pins on single-formula facilities don't participate in packing.
    if (facility?.cacheSlots == null) continue;
    // Does ANY valid shape on this facility contain the pinned recipe?
    const recipesOnFac: Recipe[] = [];
    for (const r of recipeMap.values()) {
      if (r.facilityId !== facility.id) continue;
      if (recipeSignature(r) !== recipeSignature(recipe)) continue;
      recipesOnFac.push(r);
    }
    // Also consider other class members on the same facility.
    for (const r of recipeMap.values()) {
      if (r.facilityId !== facility.id) continue;
      if (recipesOnFac.some((x) => x.id === r.id)) continue;
      // Include if it's in the same class as any already-included recipe.
      if (
        recipesOnFac.some(
          (x) => recipeSignature(x) === recipeSignature(r),
        )
      ) {
        recipesOnFac.push(r);
      }
    }
    const shapes = enumerateBinShapes(recipesOnFac, facility, itemMap);
    const hasShape = shapes.some((s) => s.recipeIds.includes(overrideRecipeId));
    if (!hasShape) {
      warnings.push(
        `Recipe override "${overrideRecipeId}" on facility "${facility.id}" has no valid bin shape — packer fell back to per-recipe bins for this recipe.`,
      );
    }
  }

  return warnings;
};

/**
 * Phase 3 entry point. Returns bins + per-recipe allocations + warnings.
 */
export const packBins = (input: PackingInput): PackingResult => {
  const { recipeSlotDemands, recipeMap, facilityMap, itemMap, recipeOverrides } =
    input;

  // Identify which recipes are eligible for multi-formula packing
  // (their facility has `cacheSlots` defined).
  const eligibleRecipeIds = new Set<RecipeId>();
  const eligibleFacilities = new Set<Facility>();
  for (const [recipeId, slotDemand] of recipeSlotDemands.entries()) {
    if (slotDemand <= SLOT_DEMAND_EPSILON) continue;
    const recipe = recipeMap.get(recipeId);
    if (!recipe) continue;
    const facility = facilityMap.get(recipe.facilityId);
    if (facility?.cacheSlots == null) continue;
    eligibleRecipeIds.add(recipeId);
    eligibleFacilities.add(facility);
    // Twins on other facilities (different facility, same signature) also
    // become candidates.
    for (const r of recipeMap.values()) {
      if (recipeSignature(r) !== recipeSignature(recipe)) continue;
      const f = facilityMap.get(r.facilityId);
      if (f?.cacheSlots != null) eligibleFacilities.add(f);
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
      `[BIN_PACKING] Enumerated ${allShapes.length} bin shapes across ${eligibleFacilities.size} facilities`,
    );
  }

  const solution = solvePacking(allShapes, classes, recipeOverrides);
  if (!solution) {
    if (import.meta.env?.DEV) {
      console.warn(
        "[BIN_PACKING] ILP failed; falling back to all-singleton bins",
      );
    }
    // Diagnose: surface infeasible-pin warnings to the user. The packer
    // never throws — fallback always produces a valid plan — but the
    // user should know why grouping didn't happen.
    const warnings = buildInfeasiblePinWarnings(
      recipeOverrides,
      recipeSlotDemands,
      recipeMap,
      facilityMap,
      itemMap,
    );
    if (warnings.length === 0) {
      warnings.push(
        "Multi-formula bin packer fell back to per-recipe bins due to an infeasible constraint configuration.",
      );
    }
    return {
      ...emitSingletonBins(
        recipeSlotDemands,
        new Map(),
        recipeMap,
        facilityMap,
        itemMap,
      ),
      warnings,
    };
  }

  if (import.meta.env?.DEV) {
    console.log(
      `[BIN_PACKING] Solved: ${solution.totalBuildings} buildings, ${solution.totalPower}W`,
    );
  }

  const packed = allocateSlotsToBins(
    solution.shapeCounts,
    classes,
    recipeMap,
    itemMap,
    recipeOverrides,
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
    warnings: [],
  };
};
