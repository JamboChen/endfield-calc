/**
 * solveLP failure-reason mapping with a MOCKED highs-wrapper — no WASM.
 *
 * Pins the "couldn't solve ≠ provably infeasible" distinction: only
 * HiGHS statuses that PROVE infeasibility may produce
 * `reason: "infeasible"`; every other terminal status (`timelimit`,
 * `error`, `unknown`, …) must surface as `reason: "solver_error"`.
 * Mislabeling them poisoned every downstream consumer — empty plans
 * masquerading as genuinely unsatisfiable targets (the frozen-app /
 * "Cannot maximize: locked targets alone exceed limits" bug).
 *
 * Lives in its own file because `vi.mock` is module-wide per file and
 * the main lp-solver suites need the real solver.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const solveMock = vi.fn();
vi.mock("@/lib/highs-wrapper", () => ({
  solve: (...args: unknown[]) => solveMock(...args),
}));

import { solveLP, type LPInput } from "@/lib/lp-solver";
import type { Facility, FacilityId, ItemId, Recipe, RecipeId } from "@/types";

/** Minimal one-recipe input: raw_a → prod, prod demanded at 10/min. */
function minimalInput(): LPInput {
  const recipe: Recipe = {
    id: "r_prod" as RecipeId,
    inputs: [{ itemId: "raw_a" as ItemId, amount: 1 }],
    outputs: [{ itemId: "prod" as ItemId, amount: 1 }],
    facilityId: "fac_a" as FacilityId,
    craftingTime: 6,
  };
  const facility = {
    id: "fac_a" as FacilityId,
    tier: 1,
    category: 6,
    powerConsumption: 100,
    buffersIn: { belt: [{ ports: 1 }], pipe: [] },
    buffersOut: { belt: [{ ports: 1 }], pipe: [] },
    domains: [],
  } satisfies Facility;
  return {
    recipes: [recipe],
    itemConstraints: new Map([
      ["prod" as ItemId, { type: "min" as const, rhs: 10 }],
    ]),
    rawMaterials: new Set(["raw_a" as ItemId]),
    costlessRaws: new Set<ItemId>(),
    facilityMap: new Map([["fac_a" as FacilityId, facility]]),
  };
}

beforeEach(() => {
  solveMock.mockReset();
});

describe("solveLP pass-1 failure-reason mapping", () => {
  test("status 'infeasible' ⇒ reason 'infeasible' (proven)", async () => {
    solveMock.mockResolvedValue({ feasible: false, status: "infeasible" });
    const result = await solveLP(minimalInput());
    expect(result.feasible).toBe(false);
    if (result.feasible) return;
    expect(result.reason).toBe("infeasible");
  });

  test("status 'unboundedorinfeasible' ⇒ reason 'infeasible' (proven)", async () => {
    solveMock.mockResolvedValue({
      feasible: false,
      status: "unboundedorinfeasible",
    });
    const result = await solveLP(minimalInput());
    expect(result.feasible).toBe(false);
    if (result.feasible) return;
    expect(result.reason).toBe("infeasible");
  });

  test("absent status (structural sentinel) ⇒ reason 'infeasible'", async () => {
    solveMock.mockResolvedValue({ feasible: false });
    const result = await solveLP(minimalInput());
    expect(result.feasible).toBe(false);
    if (result.feasible) return;
    expect(result.reason).toBe("infeasible");
  });

  test("non-proof statuses ⇒ reason 'solver_error', never 'infeasible'", async () => {
    for (const status of ["timelimit", "error", "unknown", "iterationlimit"]) {
      solveMock.mockResolvedValue({ feasible: false, status });
      const result = await solveLP(minimalInput());
      expect(result.feasible).toBe(false);
      if (result.feasible) return;
      expect(result.reason).toBe("solver_error");
    }
  });

  test("wrapper throw ⇒ reason 'solver_error' (pre-existing path)", async () => {
    solveMock.mockRejectedValue(new Error("wasm exploded"));
    const result = await solveLP(minimalInput());
    expect(result.feasible).toBe(false);
    if (result.feasible) return;
    expect(result.reason).toBe("solver_error");
  });
});
