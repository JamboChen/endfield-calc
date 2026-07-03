/**
 * Client for the calculation worker (`src/workers/calc.worker.ts`).
 *
 * Responsibilities:
 *   1. **Transport** — module-worker preferred; graceful main-thread
 *     fallback (dynamic import of `@/lib/calculator` + HiGHS) when
 *     Workers are unavailable (vitest/node), construction fails, or
 *     the worker crashes twice. Mirrors the ELK dual-path precedent
 *     (`src/lib/layout.ts`).
 *   2. **Latest-wins coalescing** — at most one job in flight and one
 *     pending; a newer request replaces the pending slot, rejecting the
 *     replaced promise with `CalcSupersededError`. This is what keeps
 *     scrub-drag commit streams from stacking solver work: however
 *     fast edits arrive, exactly one solve runs and only the newest
 *     waits.
 *
 * Callers treat `CalcSupersededError` as "ignore silently" — a newer
 * request is already carrying the fresh answer (see the catch branch
 * in `useProductionPlan`'s calc effect).
 */
import type { CalculateProductionPlanOptions } from "@/lib/calculator";
import type {
  Facility,
  Item,
  ItemId,
  ProductionDependencyGraph,
  Recipe,
} from "@/types";
import type {
  CalcSolveRequest,
  CalcWorkerResponse,
} from "@/workers/calc.worker";

export interface CalcRequest {
  targets: Array<{ itemId: ItemId; rate: number }>;
  items: readonly Item[];
  recipes: readonly Recipe[];
  facilities: readonly Facility[];
  options: CalculateProductionPlanOptions;
}

/** Rejection sentinel for requests displaced by a newer one. */
export class CalcSupersededError extends Error {
  constructor() {
    super("calculation superseded by a newer request");
    this.name = "CalcSupersededError";
  }
}

export function isCalcSuperseded(e: unknown): e is CalcSupersededError {
  return e instanceof CalcSupersededError;
}

type Job = {
  req: CalcRequest;
  resolve: (plan: ProductionDependencyGraph) => void;
  reject: (e: unknown) => void;
};

let worker: Worker | null = null;
let workerReady = false;
let readyPromise: Promise<void> | null = null;
/** Consecutive worker failures; ≥2 → permanent main-thread fallback. */
let workerFailures = 0;
let seqCounter = 0;
let inflight: (Job & { seq: number }) | null = null;
let pending: Job | null = null;

const FALLBACK_AFTER_FAILURES = 2;

function shouldFallback(): boolean {
  return (
    typeof Worker === "undefined" || workerFailures >= FALLBACK_AFTER_FAILURES
  );
}

/**
 * Tear down a dead worker and fail active jobs. The NEXT request will
 * recreate the worker (or switch to the fallback once the failure
 * budget is exhausted).
 */
function onWorkerDeath(error: unknown) {
  workerFailures++;
  workerReady = false;
  readyPromise = null;
  worker?.terminate();
  worker = null;
  const failure =
    error instanceof Error ? error : new Error(String(error ?? "worker died"));
  inflight?.reject(failure);
  inflight = null;
  pending?.reject(failure);
  pending = null;
}

function ensureWorker(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise<void>((resolve, reject) => {
    try {
      worker = new Worker(
        new URL("../workers/calc.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (e) {
      readyPromise = null;
      workerFailures++;
      reject(e);
      return;
    }
    worker.onmessage = (e: MessageEvent<CalcWorkerResponse>) => {
      const msg = e.data;
      if (msg.kind === "ready") {
        workerReady = true;
        // Worker survived init: reset the failure budget so a later
        // one-off crash doesn't tip permanently into fallback.
        workerFailures = 0;
        resolve();
        return;
      }
      if (!inflight || msg.seq !== inflight.seq) return; // stale — drop
      const job = inflight;
      inflight = null;
      if (msg.kind === "result") {
        job.resolve(msg.plan as ProductionDependencyGraph);
      } else {
        job.reject(new Error(msg.message));
      }
      dispatchPending();
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || "calc worker error");
      reject(err);
      onWorkerDeath(err);
    };
  });
  return readyPromise;
}

async function solveOnMainThread(
  req: CalcRequest,
): Promise<ProductionDependencyGraph> {
  const [{ calculateProductionPlan }, { initHighs }] = await Promise.all([
    import("@/lib/calculator"),
    import("@/lib/highs-singleton"),
  ]);
  await initHighs();
  return calculateProductionPlan(
    req.targets,
    req.items,
    req.recipes,
    req.facilities,
    req.options,
  );
}

function dispatchPending() {
  if (!pending || inflight) return;
  const job = pending;
  pending = null;
  dispatch(job);
}

function dispatch(job: Job) {
  const seq = ++seqCounter;
  inflight = { ...job, seq };
  if (shouldFallback()) {
    solveOnMainThread(job.req)
      .then((plan) => {
        if (inflight?.seq === seq) {
          inflight = null;
          job.resolve(plan);
          dispatchPending();
        }
      })
      .catch((e) => {
        if (inflight?.seq === seq) {
          inflight = null;
          job.reject(e);
          dispatchPending();
        }
      });
    return;
  }
  ensureWorker()
    .then(() => {
      // The worker may have died while we awaited readiness.
      if (inflight?.seq !== seq) return;
      const msg: CalcSolveRequest = { kind: "solve", seq, ...job.req };
      worker!.postMessage(msg);
    })
    .catch(() => {
      // Construction/init failed — retry this very job through the
      // (possibly fallback) path rather than failing the caller.
      if (inflight?.seq !== seq) return;
      inflight = null;
      dispatch(job);
    });
}

/**
 * Begin loading the calculation engine (worker + WASM). Idempotent;
 * call at app mount so the first calculation finds a warm solver —
 * the same contract `initHighs()` had before the worker migration.
 */
export function initCalcEngine(): Promise<void> {
  if (shouldFallback()) {
    return import("@/lib/highs-singleton").then(({ initHighs }) =>
      initHighs().then(() => undefined),
    );
  }
  return ensureWorker().catch(() =>
    // Worker path failed at startup — warm the fallback instead.
    import("@/lib/highs-singleton").then(({ initHighs }) =>
      initHighs().then(() => undefined),
    ),
  );
}

/** True when a solver (worker or fallback) is warm. */
export function isCalcEngineReady(): boolean {
  return workerReady || shouldFallback();
}

/**
 * Solve a plan. Latest-wins: if a job is already running, this request
 * parks in the single pending slot, displacing (and rejecting with
 * `CalcSupersededError`) whatever waited there before.
 */
export function calculate(
  req: CalcRequest,
): Promise<ProductionDependencyGraph> {
  return new Promise<ProductionDependencyGraph>((resolve, reject) => {
    const job: Job = { req, resolve, reject };
    if (inflight) {
      pending?.reject(new CalcSupersededError());
      pending = job;
      return;
    }
    dispatch(job);
  });
}
