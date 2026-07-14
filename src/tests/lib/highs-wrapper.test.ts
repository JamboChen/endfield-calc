/**
 * highs-wrapper unit tests with a MOCKED singleton — no WASM.
 *
 * Pins the cumulative-clock compensation: HiGHS's `time_limit` is
 * checked against a run clock that accumulates across every solve on
 * an instance and cannot be reset (verified empirically — see the
 * `accumulatedSolveSeconds` JSDoc in highs-wrapper.ts). The wrapper
 * must therefore set `time_limit = accumulated + perSolveBudget` on
 * EVERY solve, and self-heal the instance on returned failure
 * statuses.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

type FakeSolution = {
  status: string;
  objective?: number;
  solution?: Map<string, number>;
};

/** Recording fake for the HiGHS instance surface the wrapper uses. */
function makeFakeInstance() {
  const params: Array<[string, unknown]> = [];
  const fake = {
    params,
    nextStatus: "optimal" as string,
    solveDelayMs: 0,
    setParam(name: string, value: unknown) {
      params.push([name, value]);
    },
    async parse() {
      /* recorded model irrelevant here */
    },
    async solve(): Promise<FakeSolution> {
      if (fake.solveDelayMs > 0) {
        await new Promise((r) => setTimeout(r, fake.solveDelayMs));
      }
      return {
        status: fake.nextStatus,
        objective: 0,
        solution: new Map([["x", 5]]),
      };
    },
  };
  return fake;
}

let fakeInstance = makeFakeInstance();
const resetHighsMock = vi.fn();

vi.mock("@/lib/highs-singleton", () => ({
  initHighs: vi.fn(async () => fakeInstance),
  resetHighs: (...args: unknown[]) => resetHighsMock(...args),
}));

import { solve, type LPModel } from "@/lib/highs-wrapper";

const trivialModel = (options?: LPModel["options"]): LPModel => ({
  optimize: "obj",
  opType: "min",
  constraints: { c1: { min: 5 } },
  variables: { x: { obj: 1, c1: 1 } },
  ...(options ? { options } : {}),
});

const timeLimitsSet = () =>
  fakeInstance.params
    .filter(([name]) => name === "time_limit")
    .map(([, v]) => v as number);

beforeEach(() => {
  // Fresh instance per test — the wrapper's accumulated-time WeakMap
  // is keyed on instance identity, so this resets the clock offset.
  fakeInstance = makeFakeInstance();
  resetHighsMock.mockClear();
});

describe("highs-wrapper time_limit handling", () => {
  test("time_limit is set on EVERY solve; no-options models get the huge default", async () => {
    await solve(trivialModel());
    const limits = timeLimitsSet();
    expect(limits).toHaveLength(1);
    expect(limits[0]).toBeGreaterThanOrEqual(1e9);
  });

  test("a model's limit never leaks onto the next solve (sticky-param regression)", async () => {
    await solve(trivialModel({ timeLimitSeconds: 30 }));
    await solve(trivialModel()); // no options — must NOT inherit 30
    const limits = timeLimitsSet();
    expect(limits).toHaveLength(2);
    expect(limits[0]).toBeGreaterThanOrEqual(30);
    expect(limits[0]).toBeLessThan(60); // 30 + accumulated(≈0)
    expect(limits[1]).toBeGreaterThanOrEqual(1e9);
  });

  test("explicit limits are offset by accumulated solve time (cumulative-clock regression)", async () => {
    // Burn measurable solve time first, then ask for a 30s budget: the
    // param must be 30 + accumulated, not a bare 30 — HiGHS compares
    // it against the instance-lifetime run clock.
    fakeInstance.solveDelayMs = 60;
    await solve(trivialModel());
    fakeInstance.solveDelayMs = 0;
    await solve(trivialModel({ timeLimitSeconds: 30 }));
    const limits = timeLimitsSet();
    expect(limits[1]).toBeGreaterThan(30.05); // 30 + ≥0.06s accumulated
    expect(limits[1]).toBeLessThan(40);
  });
});

describe("highs-wrapper failure-status handling", () => {
  test("raw status is surfaced on the result", async () => {
    fakeInstance.nextStatus = "timelimit";
    const r = await solve(trivialModel());
    expect(r.feasible).toBe(false);
    expect(r.status).toBe("timelimit");
  });

  test("status 'error' / 'unknown' self-heal the instance (resetHighs)", async () => {
    for (const status of ["error", "unknown"]) {
      resetHighsMock.mockClear();
      fakeInstance.nextStatus = status;
      const r = await solve(trivialModel());
      expect(r.feasible).toBe(false);
      expect(r.status).toBe(status);
      expect(resetHighsMock).toHaveBeenCalledTimes(1);
    }
  });

  test("'timelimit' and 'infeasible' do NOT reset (healthy instance)", async () => {
    for (const status of ["timelimit", "infeasible"]) {
      fakeInstance.nextStatus = status;
      await solve(trivialModel());
    }
    expect(resetHighsMock).not.toHaveBeenCalled();
  });

  test("optimal solves stay intact: feasible, status, variables", async () => {
    const r = await solve(trivialModel());
    expect(r.feasible).toBe(true);
    expect(r.status).toBe("optimal");
    expect(r.x).toBe(5);
  });
});
