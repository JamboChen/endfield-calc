import { describe, test, expect } from "vitest";
import {
  rawsInChainOf,
  isPlanFeasible,
  maximizeTargetRate,
  fitTargetsToLimits,
  type OptimizableTarget,
  type TargetVectorEntry,
  type FeasibilityContext,
} from "@/lib/target-optimizer";
import { calculateProductionPlan } from "@/lib/calculator";
import { items, recipes, facilities } from "@/data";
import { ItemId as ItemIdEnum } from "@/types/constants";
import type {
  Facility,
  Item,
  ItemId,
  PlanLpStatus,
  ProductionDependencyGraph,
  Recipe,
  FacilityId,
  RecipeId,
} from "@/types";
import { ALL_RAWS } from "./utils";

/** Minimal fully-typed plan shell — what `calculateProductionPlan`
 *  returns on a failed solve (modulo target/raw item nodes). */
function fakePlan(lpStatus: PlanLpStatus): ProductionDependencyGraph {
  return {
    nodes: new Map(),
    edges: [],
    targets: new Set(),
    detectedCycles: [],
    invalidCycles: [],
    lpStatus,
    bins: [],
    recipeBinAllocations: new Map(),
    warnings: [],
    metastorageImports: [],
  };
}

const emptyCtx: FeasibilityContext = { facilities: [], items: [] };

/** Terse synthetic-recipe builder (tests only — casts are fine here). */
function recipe(
  id: string,
  inputs: [string, number][],
  outputs: [string, number][],
  facilityId = "synth_facility",
  craftingTime = 2,
): Recipe {
  return {
    id: id as RecipeId,
    inputs: inputs.map(([itemId, amount]) => ({
      itemId: itemId as ItemId,
      amount,
    })),
    outputs: outputs.map(([itemId, amount]) => ({
      itemId: itemId as ItemId,
      amount,
    })),
    facilityId: facilityId as FacilityId,
    craftingTime,
  };
}

const raws = (...ids: string[]) => new Set(ids.map((i) => i as ItemId));

describe("rawsInChainOf (Max-button gating closure)", () => {
  test("linear chain: raw → mid → final resolves the root raw", () => {
    const rs = [
      recipe("r_mid", [["raw_a", 1]], [["mid", 1]]),
      recipe("r_final", [["mid", 2]], [["final", 1]]),
    ];
    const result = rawsInChainOf("final" as ItemId, rs, raws("raw_a"));
    expect(result).toEqual(raws("raw_a"));
  });

  test("alternative producers: all branches contribute their raws", () => {
    // `final` can be made from raw_a OR raw_b — the closure walks every
    // alternative producer (mirrors the graph builder's no-single-pick
    // philosophy), so both raws gate the Max button.
    const rs = [
      recipe("r_a", [["raw_a", 1]], [["final", 1]]),
      recipe("r_b", [["raw_b", 1]], [["final", 1]]),
    ];
    const result = rawsInChainOf(
      "final" as ItemId,
      rs,
      raws("raw_a", "raw_b"),
    );
    expect(result).toEqual(raws("raw_a", "raw_b"));
  });

  test("cycles terminate: planter ↔ seed loop with a raw feed", () => {
    // planter: seed + water → plant; seedmaker: plant → seed.
    // The plant↔seed cycle must not loop forever; water is the only raw.
    const rs = [
      recipe(
        "r_plant",
        [
          ["seed", 1],
          ["raw_water", 1],
        ],
        [["plant", 1]],
      ),
      recipe("r_seed", [["plant", 1]], [["seed", 2]]),
    ];
    const result = rawsInChainOf("plant" as ItemId, rs, raws("raw_water"));
    expect(result).toEqual(raws("raw_water"));
  });

  test("raws terminate their branch even when a recipe emits them", () => {
    // A recipe that outputs raw_a as a byproduct must not pull raw_a's
    // own inputs into the closure — raws are sourced from pickup
    // points, so the cap applies regardless of any producer.
    const rs = [
      recipe("r_weird", [["raw_b", 1]], [["raw_a", 1]]),
      recipe("r_final", [["raw_a", 1]], [["final", 1]]),
    ];
    const result = rawsInChainOf(
      "final" as ItemId,
      rs,
      raws("raw_a", "raw_b"),
    );
    // raw_a terminates; raw_b (only reachable THROUGH raw_a's producer)
    // is not part of the chain.
    expect(result).toEqual(raws("raw_a"));
  });

  test("item with no producers and not raw → empty set", () => {
    const result = rawsInChainOf("orphan" as ItemId, [], raws("raw_a"));
    expect(result.size).toBe(0);
  });

  test("unreachable raws are excluded", () => {
    const rs = [
      recipe("r_final", [["raw_a", 1]], [["final", 1]]),
      recipe("r_other", [["raw_b", 1]], [["other", 1]]),
    ];
    const result = rawsInChainOf(
      "final" as ItemId,
      rs,
      raws("raw_a", "raw_b"),
    );
    expect(result).toEqual(raws("raw_a"));
  });

  test("real data: Cuprium Part chain = exactly {water, copper ore}", () => {
    const result = rawsInChainOf(
      ItemIdEnum.ITEM_COPPER_CMPT,
      recipes,
      ALL_RAWS,
    );
    expect(result).toEqual(
      new Set([ItemIdEnum.ITEM_LIQUID_WATER, ItemIdEnum.ITEM_COPPER_ORE]),
    );
  });

  test("real data: Xiranite Poly chain reaches water; only raws returned", () => {
    const result = rawsInChainOf(
      ItemIdEnum.ITEM_XIRANITE_POLY,
      recipes,
      ALL_RAWS,
    );
    expect(result.has(ItemIdEnum.ITEM_LIQUID_WATER)).toBe(true);
    expect(result.size).toBeGreaterThan(0);
    // Every returned id must actually be a raw.
    for (const id of result) {
      expect(ALL_RAWS.has(id)).toBe(true);
    }
  });
});

/* ── Bisection engines (maximizeTargetRate / fitTargetsToLimits) ────
 *
 * Synthetic world, per the repo's latent-bug test convention: one raw
 * (`raw_w`), two 1:1 recipes on two single-formula facilities, each
 * producing 10/min per building (craftingTime 6). Analytic optima are
 * exact, isolated from upstream-data drift.
 */

function synthItem(id: string): Item {
  return { id: id as ItemId, tier: 1 };
}

function synthFacility(id: string): Facility {
  return {
    id: id as FacilityId,
    tier: 1,
    category: 6,
    powerConsumption: 100,
    buffersIn: { belt: [{ ports: 1 }, { ports: 1 }], pipe: [] },
    buffersOut: { belt: [{ ports: 1 }, { ports: 1 }], pipe: [] },
    domains: [],
  };
}

const worldItems = [
  synthItem("raw_w"),
  synthItem("prod_a"),
  synthItem("prod_b"),
  synthItem("prod_c"),
];
const worldFacilities = [synthFacility("fac_a"), synthFacility("fac_b")];
const worldRecipes = [
  // craftingTime 6s → calcRate(1, 6) = 10/min per building.
  recipe("r_a", [["raw_w", 1]], [["prod_a", 1]], "fac_a", 6),
  recipe("r_b", [["raw_w", 1]], [["prod_b", 1]], "fac_b", 6),
  recipe("r_c", [["raw_w", 1]], [["prod_c", 1]], "fac_a", 6),
];
const worldRaws = raws("raw_w") as Set<ItemId>;

/** Solve + feasibility pair for one cap configuration. `solve` counts
 *  invocations so cancellation tests can assert zero solver work. */
function makeWorld(caps: {
  rawCap?: number;
  facBCap?: number;
}): {
  solve: (v: TargetVectorEntry[]) => Promise<ProductionDependencyGraph>;
  feasibility: FeasibilityContext;
  solveCount: () => number;
} {
  const rawCaps =
    caps.rawCap !== undefined
      ? new Map<ItemId, number>([["raw_w" as ItemId, caps.rawCap]])
      : undefined;
  const facilityCaps =
    caps.facBCap !== undefined
      ? new Map<FacilityId, number>([["fac_b" as FacilityId, caps.facBCap]])
      : undefined;
  let count = 0;
  return {
    solve: (vector) => {
      count++;
      return calculateProductionPlan(
        vector,
        worldItems,
        worldRecipes,
        worldFacilities,
        { rawMaterials: worldRaws, rawCaps, facilityCaps },
      );
    },
    feasibility: {
      facilities: worldFacilities,
      items: worldItems,
      rawCaps,
      facilityCaps,
    },
    solveCount: () => count,
  };
}

const target = (
  id: string,
  rate: number,
  locked?: boolean,
): OptimizableTarget =>
  locked
    ? { itemId: id as ItemId, rate, locked: true }
    : { itemId: id as ItemId, rate };

describe("maximizeTargetRate (priority-Max)", () => {
  test("analytic max vs raw cap: single target, cap 30, 1:1 → 30.000", async () => {
    const w = makeWorld({ rawCap: 30 });
    const result = await maximizeTargetRate({
      targets: [target("prod_a", 5)],
      index: 0,
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rate).toBeCloseTo(30, 3);
    expect(result.otherRates.size).toBe(0);
  });

  test("priority over unlocked: Max(B) takes A's share → B=30, A=0", async () => {
    const w = makeWorld({ rawCap: 30 });
    const result = await maximizeTargetRate({
      targets: [target("prod_a", 10), target("prod_b", 5)],
      index: 1,
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rate).toBeCloseTo(30, 3);
    // Pass 2 verified A cannot recover anything.
    expect(result.otherRates.get(0)).toBeCloseTo(0, 3);
  });

  test("leftover recovery: B facility-capped at 20 → A keeps its 10", async () => {
    // fac_b cap 2 buildings × 10/min = 20/min for B; raw cap 30 leaves
    // exactly A's desired 10 → pass 2 is a λ=1 noop (A untouched).
    const w = makeWorld({ rawCap: 30, facBCap: 2 });
    const result = await maximizeTargetRate({
      targets: [target("prod_a", 10), target("prod_b", 5)],
      index: 1,
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rate).toBeCloseTo(20, 3);
    expect(result.otherRates.size).toBe(0);
  });

  test("lock protection: locked A=10 is frozen in pass 1 → B max = 20", async () => {
    const w = makeWorld({ rawCap: 30 });
    const result = await maximizeTargetRate({
      targets: [target("prod_a", 10, true), target("prod_b", 5)],
      index: 1,
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rate).toBeCloseTo(20, 3);
    // Locked targets never appear in otherRates.
    expect(result.otherRates.size).toBe(0);
  });

  test("facility cap binds tighter than raw cap (via physicalPerFacility)", async () => {
    const w = makeWorld({ rawCap: 30, facBCap: 2 });
    const result = await maximizeTargetRate({
      targets: [target("prod_b", 5)],
      index: 0,
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rate).toBeCloseTo(20, 3);
  });

  test("rate 0 is a valid maximum: locked demand exactly exhausts the cap", async () => {
    const w = makeWorld({ rawCap: 30 });
    const result = await maximizeTargetRate({
      targets: [target("prod_a", 30, true), target("prod_b", 5)],
      index: 1,
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rate).toBeCloseTo(0, 3);
  });

  test("infeasible: locked demands alone blow the cap", async () => {
    const w = makeWorld({ rawCap: 30 });
    const result = await maximizeTargetRate({
      targets: [target("prod_a", 40, true), target("prod_b", 5)],
      index: 1,
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("infeasible");
  });

  test("unbounded: no binding caps + small injected ceiling", async () => {
    const w = makeWorld({});
    const result = await maximizeTargetRate({
      targets: [target("prod_a", 1)],
      index: 0,
      maxRateCeiling: 64,
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("unbounded");
  });

  test("verified-feasible invariant: the returned vector re-solves feasible", async () => {
    const w = makeWorld({ rawCap: 30, facBCap: 2 });
    const targets = [target("prod_a", 10), target("prod_b", 5)];
    const result = await maximizeTargetRate({
      targets,
      index: 1,
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const finalVector = targets.map((t, i) => ({
      itemId: t.itemId,
      rate:
        i === 1 ? result.rate : (result.otherRates.get(i) ?? t.rate),
    }));
    const plan = await w.solve(finalVector.filter((t) => t.rate > 0));
    expect(isPlanFeasible(plan, w.feasibility)).toBe(true);
  });

  test("cancellation: no solver work when cancelled up front", async () => {
    const w = makeWorld({ rawCap: 30 });
    const result = await maximizeTargetRate({
      targets: [target("prod_a", 5)],
      index: 0,
      solve: w.solve,
      feasibility: w.feasibility,
      isCancelled: () => true,
    });
    expect(result.kind).toBe("cancelled");
    expect(w.solveCount()).toBe(0);
  });

  test("real data: Cuprium Part max under water + copper-ore caps is finite and feasible", async () => {
    // Cuprium Part's chain raws are exactly {water, copper ore} (see
    // the rawsInChainOf test above) — capping both makes the maximum
    // provably finite regardless of which producers the LP picks.
    const rawCaps = new Map<ItemId, number>([
      [ItemIdEnum.ITEM_LIQUID_WATER, 120],
      [ItemIdEnum.ITEM_COPPER_ORE, 60],
    ]);
    const solve = (vector: TargetVectorEntry[]) =>
      calculateProductionPlan(vector, items, recipes, facilities, {
        rawMaterials: ALL_RAWS,
        rawCaps,
      });
    const feasibility: FeasibilityContext = {
      facilities,
      items,
      rawCaps,
    };
    const result = await maximizeTargetRate({
      targets: [{ itemId: ItemIdEnum.ITEM_COPPER_CMPT, rate: 1 }],
      index: 0,
      solve,
      feasibility,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rate).toBeGreaterThan(0);
    const plan = await solve([
      { itemId: ItemIdEnum.ITEM_COPPER_CMPT, rate: result.rate },
    ]);
    expect(isPlanFeasible(plan, feasibility)).toBe(true);
  });
});

describe("fitTargetsToLimits", () => {
  test("analytic λ: locked 20 + flexible desired 20 under cap 30 → 10.000", async () => {
    const w = makeWorld({ rawCap: 30 });
    const result = await fitTargetsToLimits({
      targets: [target("prod_a", 20, true), target("prod_b", 20)],
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rates.size).toBe(1);
    expect(result.rates.get(1)).toBeCloseTo(10, 3);
  });

  test("excludeIndex holds its rate; the rest scale by one common λ", async () => {
    // A (excluded) keeps 10; B=20 and C=10 share the remaining 20 →
    // λ = 2/3, floor-rounded onto the milli grid.
    const w = makeWorld({ rawCap: 30 });
    const result = await fitTargetsToLimits({
      targets: [
        target("prod_a", 10),
        target("prod_b", 20),
        target("prod_c", 10),
      ],
      excludeIndex: 0,
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rates.has(0)).toBe(false);
    expect(result.rates.get(1)).toBeCloseTo(13.333, 3);
    expect(result.rates.get(2)).toBeCloseTo(6.666, 3);
  });

  test("noop when the current vector already fits", async () => {
    const w = makeWorld({ rawCap: 30 });
    const result = await fitTargetsToLimits({
      targets: [target("prod_a", 10), target("prod_b", 10)],
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("noop");
  });

  test("impossible: all-locked over-cap", async () => {
    const w = makeWorld({ rawCap: 30 });
    const result = await fitTargetsToLimits({
      targets: [target("prod_a", 20, true), target("prod_b", 20, true)],
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("impossible");
  });

  test("impossible: locked demand alone blows the cap even with flexible at 0", async () => {
    const w = makeWorld({ rawCap: 30 });
    const result = await fitTargetsToLimits({
      targets: [target("prod_a", 40, true), target("prod_b", 20)],
      solve: w.solve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("impossible");
  });
});

describe("isPlanFeasible", () => {
  test("metastorage-budget-insufficient warning ⇒ infeasible", () => {
    // Unit-level: full metastorage route setup is too heavy for a
    // synthetic end-to-end — the clause is a plain warning scan.
    const plan = fakePlan("ok");
    plan.warnings = [
      {
        kind: "metastorage-budget-insufficient",
        sourceDomain: "domain_1",
        itemId: "item_x",
        neededPerCycle: 10,
        capPerCycle: 5,
      },
    ] as unknown as ProductionDependencyGraph["warnings"];
    expect(isPlanFeasible(plan, emptyCtx)).toBe(false);
    expect(isPlanFeasible({ ...plan, warnings: [] }, emptyCtx)).toBe(true);
  });

  test("lpStatus matrix: only 'ok' plans can be feasible", () => {
    // A failed solve returns an empty shell that passes every cap
    // check vacuously — the lpStatus clause is what stops a wedged
    // solver from turning every probe "feasible" (the frozen-state
    // "No limit reached on any target" bug).
    expect(isPlanFeasible(fakePlan("ok"), emptyCtx)).toBe(true);
    for (const status of [
      "infeasible",
      "unbounded",
      "solver_error",
    ] as const) {
      expect(isPlanFeasible(fakePlan(status), emptyCtx)).toBe(false);
    }
  });
});

describe("probe vectors mirror the UI calc problem", () => {
  test("every probe includes ALL targets — zero-rate entries not dropped", async () => {
    // A rate-0 target still roots graph traversal (producer closure,
    // disposal-injection, forced-disposal constraint flips), so probes
    // that omit them judge a DIFFERENT problem than the UI solves
    // after the commit — the SC-Wuling-Battery "Max commits a rate
    // that re-solves over-cap" ratchet bug.
    const w = makeWorld({ rawCap: 30 });
    const captured: TargetVectorEntry[][] = [];
    const spySolve = (v: TargetVectorEntry[]) => {
      captured.push(v.map((t) => ({ ...t })));
      return w.solve(v);
    };
    const result = await maximizeTargetRate({
      targets: [target("prod_a", 10), target("prod_b", 5)],
      index: 1,
      solve: spySolve,
      feasibility: w.feasibility,
    });
    expect(result.kind).toBe("ok");
    expect(captured.length).toBeGreaterThan(0);
    for (const vector of captured) {
      expect(vector).toHaveLength(2);
      expect(vector.map((t) => t.itemId).sort()).toEqual([
        "prod_a",
        "prod_b",
      ]);
    }
    // Pass-1 probes carry the unlocked other at an explicit rate 0.
    expect(
      captured.some((v) =>
        v.some((t) => t.itemId === ("prod_a" as ItemId) && t.rate === 0),
      ),
    ).toBe(true);
  });
});

describe("failed-solve (lpStatus) handling in the engines", () => {
  test("all probes lpStatus=infeasible ⇒ 'infeasible', never 'unbounded'", async () => {
    // Regression: empty shells used to pass the feasibility predicate
    // vacuously, so a broken solver made Max bracket to the ceiling
    // and report "no limit reached".
    const brokenSolve = () => Promise.resolve(fakePlan("infeasible"));
    const result = await maximizeTargetRate({
      targets: [target("prod_a", 5)],
      index: 0,
      solve: brokenSolve,
      feasibility: emptyCtx,
    });
    expect(result.kind).toBe("infeasible");
  });

  test("lpStatus boundary is a legitimate bisection verdict", async () => {
    // Import-only-above-budget style failure: LP-infeasible above a
    // demand threshold, fine below. The bisection must converge onto
    // the threshold using lpStatus alone (no cap warnings involved).
    const thresholdSolve = (v: TargetVectorEntry[]) => {
      const total = v.reduce((acc, t) => acc + t.rate, 0);
      return Promise.resolve(
        fakePlan(total <= 20 + 1e-9 ? "ok" : "infeasible"),
      );
    };
    const result = await maximizeTargetRate({
      targets: [target("prod_a", 5)],
      index: 0,
      solve: thresholdSolve,
      feasibility: emptyCtx,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rate).toBeCloseTo(20, 3);
  });

  test("mid-search wedge: pass-2 contradiction rejects, never commits", async () => {
    // Simulates the solver wedging BETWEEN pass 1 and pass 2 (the
    // all-locked SC-Wuling-Battery freeze): pass-1 probes verify a
    // rate, then every later solve fails. Pass 2's λ-probes then
    // contradict pass 1's verified vector — the engine must abort,
    // not commit the now-unverifiable rate. The wedge flips on the
    // first pass-2-shaped vector: only pass 2 solves with the unlocked
    // other at its DESIRED rate while X sits above its starting rate
    // (pass-1 probes always carry the other at 0).
    let wedged = false;
    const wedgingSolve = (v: TargetVectorEntry[]) => {
      const other = v.find((t) => t.itemId === ("prod_a" as ItemId))!;
      const x = v.find((t) => t.itemId === ("prod_b" as ItemId))!;
      if (other.rate > 0 && x.rate > 5) wedged = true;
      const total = v.reduce((acc, t) => acc + t.rate, 0);
      return Promise.resolve(
        fakePlan(wedged || total > 20 + 1e-9 ? "infeasible" : "ok"),
      );
    };
    await expect(
      maximizeTargetRate({
        targets: [target("prod_a", 10), target("prod_b", 5)],
        index: 1,
        solve: wedgingSolve,
        feasibility: emptyCtx,
      }),
    ).rejects.toThrow(/contradicted pass-1/);
  });

  test("lpStatus=solver_error rejects the search — never a verdict", async () => {
    // A wedged solver is evidence, not information: counting it as
    // "infeasible" would corrupt the bracket. The hook maps the
    // rejection to an error toast + abort.
    const wedgedSolve = () => Promise.resolve(fakePlan("solver_error"));
    await expect(
      maximizeTargetRate({
        targets: [target("prod_a", 5)],
        index: 0,
        solve: wedgedSolve,
        feasibility: emptyCtx,
      }),
    ).rejects.toThrow(/solver error/);
    await expect(
      fitTargetsToLimits({
        targets: [target("prod_a", 5), target("prod_b", 5)],
        solve: wedgedSolve,
        feasibility: emptyCtx,
      }),
    ).rejects.toThrow(/solver error/);
  });
});

describe("lpStatus threading (calculateProductionPlan)", () => {
  test("healthy solve ⇒ lpStatus 'ok'", async () => {
    const plan = await calculateProductionPlan(
      [{ itemId: "prod_a" as ItemId, rate: 10 }],
      worldItems,
      worldRecipes,
      worldFacilities,
      { rawMaterials: worldRaws },
    );
    expect(plan.lpStatus).toBe("ok");
  });

  test("structurally infeasible LP ⇒ lpStatus 'infeasible' on the empty shell", async () => {
    // Self-loop with zero net gain: r_self consumes 1 item_a and
    // produces 1 item_a, so the balance row collapses to `0 ≥ 30` —
    // structurally infeasible. The plan must come back as the marked
    // empty shell, not a silent success.
    const selfLoop = [
      recipe("r_self", [["item_a", 1]], [["item_a", 1]], "fac_a", 6),
    ];
    const plan = await calculateProductionPlan(
      [{ itemId: "item_a" as ItemId, rate: 30 }],
      [synthItem("item_a")],
      selfLoop,
      worldFacilities,
      { rawMaterials: new Set<ItemId>() },
    );
    expect(plan.lpStatus).toBe("infeasible");
    expect(plan.bins).toHaveLength(0);
  });
});
