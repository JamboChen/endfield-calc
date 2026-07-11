/**
 * calc-client transport tests with a FAKE Worker — no WASM, no real
 * solver.
 *
 * Pins the client's resilience contract:
 *   1. Latest-wins coalescing (one inflight + one pending slot;
 *      displaced pending jobs reject with `CalcSupersededError`).
 *   2. A worker crash mid-solve is INVISIBLE to callers — the inflight
 *      job is re-dispatched onto a fresh worker, and after the per-job
 *      retry budget is exhausted, onto the main-thread fallback. The
 *      pre-fix behavior (rejecting the caller with a raw crash error,
 *      blanking the plan UI) is the regression this file guards.
 *   3. Worker-side CALCULATION errors (the `{ kind: "error" }`
 *      protocol message) still reject the caller — those are real
 *      solve failures, not transport faults.
 *
 * `@/lib/calculator` + `@/lib/highs-singleton` are mocked so the
 * fallback path is observable without running the real pipeline. The
 * client's module-level state (worker, budgets, queue slots) is reset
 * between tests via `vi.resetModules()` + a fresh dynamic import.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { CalcRequest } from "@/lib/calc-client";

const FAKE_PLAN = { fake: "plan" };

vi.mock("@/lib/calculator", () => ({
  calculateProductionPlan: vi.fn(async () => FAKE_PLAN),
}));
vi.mock("@/lib/highs-singleton", () => ({
  initHighs: vi.fn(async () => ({})),
}));

/** Recording fake for the DOM Worker surface the client uses. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  posted: Array<{ kind: string; seq: number }> = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: { kind: string; seq: number }) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }

  emitReady() {
    this.onmessage?.({ data: { kind: "ready" } });
  }
  emitResult(seq: number, plan: unknown = FAKE_PLAN) {
    this.onmessage?.({ data: { kind: "result", seq, plan } });
  }
  emitError(seq: number, message: string) {
    this.onmessage?.({ data: { kind: "error", seq, message } });
  }
  crash(message = "worker exploded") {
    this.onerror?.({ message });
  }
}

/** Drain microtasks + one macrotask so `ensureWorker().then` chains run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const makeRequest = (): CalcRequest => ({
  targets: [],
  items: [],
  recipes: [],
  facilities: [],
  options: { rawMaterials: new Set() },
});

async function importClient() {
  return await import("@/lib/calc-client");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  // The death path logs a warning by design — keep test output clean.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("calc-client worker transport", () => {
  test("happy path: solve round-trips through the worker", async () => {
    const client = await importClient();
    const promise = client.calculate(makeRequest());

    const [w] = FakeWorker.instances;
    w.emitReady();
    await flush();
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]).toMatchObject({ kind: "solve", seq: 1 });

    w.emitResult(1);
    await expect(promise).resolves.toBe(FAKE_PLAN);
  });

  test("latest-wins: displaced pending job rejects with CalcSupersededError", async () => {
    const client = await importClient();
    const first = client.calculate(makeRequest());
    const displaced = client.calculate(makeRequest()); // parks pending
    const newest = client.calculate(makeRequest()); // displaces it

    await expect(displaced).rejects.toSatisfy((e) =>
      client.isCalcSuperseded(e),
    );

    const [w] = FakeWorker.instances;
    w.emitReady();
    await flush();
    w.emitResult(w.posted[0].seq);
    await expect(first).resolves.toBe(FAKE_PLAN);

    await flush();
    expect(w.posted).toHaveLength(2);
    w.emitResult(w.posted[1].seq);
    await expect(newest).resolves.toBe(FAKE_PLAN);
  });

  test("worker calculation errors reject the caller (not a transport retry)", async () => {
    const client = await importClient();
    const promise = client.calculate(makeRequest());

    const [w] = FakeWorker.instances;
    w.emitReady();
    await flush();
    w.emitError(w.posted[0].seq, "No targets specified");

    await expect(promise).rejects.toThrow("No targets specified");
    expect(FakeWorker.instances).toHaveLength(1); // no worker recycle
  });

  test("mid-solve crash: job is retried on a fresh worker, caller never sees it", async () => {
    const client = await importClient();
    const promise = client.calculate(makeRequest());

    const [w1] = FakeWorker.instances;
    w1.emitReady();
    await flush();
    expect(w1.posted).toHaveLength(1);

    w1.crash();
    await flush();
    expect(w1.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);

    const w2 = FakeWorker.instances[1];
    w2.emitReady();
    await flush();
    expect(w2.posted).toHaveLength(1);
    expect(w2.posted[0].seq).toBeGreaterThan(w1.posted[0].seq);

    w2.emitResult(w2.posted[0].seq);
    await expect(promise).resolves.toBe(FAKE_PLAN);
  });

  test("retry budget: a job that crashes two workers falls back to the main thread", async () => {
    const client = await importClient();
    const promise = client.calculate(makeRequest());

    const [w1] = FakeWorker.instances;
    w1.emitReady();
    await flush();
    w1.crash();
    await flush();

    // Second worker inits fine (which RESETS the global failure
    // budget) and still crashes — the per-job budget must catch this.
    const w2 = FakeWorker.instances[1];
    w2.emitReady();
    await flush();
    expect(w2.posted).toHaveLength(1);
    w2.crash();
    await flush();

    await expect(promise).resolves.toBe(FAKE_PLAN);
    const { calculateProductionPlan } = await import("@/lib/calculator");
    expect(calculateProductionPlan).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(2); // no third worker
  });

  test("pending job survives a crash and runs after the retried job", async () => {
    const client = await importClient();
    const first = client.calculate(makeRequest());
    const second = client.calculate(makeRequest()); // parks pending

    const [w1] = FakeWorker.instances;
    w1.emitReady();
    await flush();
    w1.crash();
    await flush();

    const w2 = FakeWorker.instances[1];
    w2.emitReady();
    await flush();
    expect(w2.posted).toHaveLength(1);
    w2.emitResult(w2.posted[0].seq);
    await expect(first).resolves.toBe(FAKE_PLAN);

    await flush();
    expect(w2.posted).toHaveLength(2);
    w2.emitResult(w2.posted[1].seq);
    await expect(second).resolves.toBe(FAKE_PLAN);
  });

  test("init failure before ready: queued job is retried, not rejected", async () => {
    const client = await importClient();
    const promise = client.calculate(makeRequest());

    // Worker dies during init (the calc.worker setTimeout-rethrow
    // path) — before ever signalling ready.
    const [w1] = FakeWorker.instances;
    w1.crash("wasm fetch failed");
    await flush();

    expect(FakeWorker.instances).toHaveLength(2);
    const w2 = FakeWorker.instances[1];
    w2.emitReady();
    await flush();
    expect(w2.posted).toHaveLength(1);
    w2.emitResult(w2.posted[0].seq);
    await expect(promise).resolves.toBe(FAKE_PLAN);
  });
});
