/**
 * Client for the calculation worker (`src/workers/calc.worker.ts`).
 *
 * Responsibilities:
 *   1. **Transport** — module-worker preferred; graceful main-thread
 *     fallback (dynamic import of `@/lib/calculator` + HiGHS) when
 *     Workers are unavailable (vitest/node), construction fails, or
 *     the failure budget is exhausted (globally or per job). A worker
 *     crash mid-solve is invisible to callers: the inflight job is
 *     re-dispatched onto a fresh worker, then onto the fallback.
 *     Mirrors the ELK dual-path precedent (`src/lib/layout.ts`).
 *   2. **Latest-wins coalescing** — at most one job in flight; a newer
 *     solve replaces the parked solve slot, rejecting the replaced
 *     promise with `CalcSupersededError`. This is what keeps
 *     scrub-drag commit streams from stacking solver work: however
 *     fast edits arrive, exactly one solve runs and only the newest
 *     waits.
 *   3. **Optimizer searches** — `searchMaximize` / `searchFit` run the
 *     whole Max/Fit bisection IN the worker as a single job (probes
 *     never round-trip plan graphs, and they can't displace a parked
 *     display solve). Searches have their own single parked slot,
 *     dispatched ahead of a parked solve — the solve then re-runs
 *     against whatever the search left behind, which is the fresher
 *     answer. Each search returns a `cancel()` handle: parked → the
 *     promise resolves `{ kind: "cancelled" }` immediately; inflight →
 *     a `cancel-search` control message flips the engines' per-probe
 *     `isCancelled` poll (fallback path polls the same flag directly).
 *
 * Callers treat `CalcSupersededError` as "ignore silently" — a newer
 * request is already carrying the fresh answer (see the catch branch
 * in `useProductionPlan`'s calc effect).
 */
import type { CalculateProductionPlanOptions } from "@/lib/calculator";
import type {
  FitResult,
  MaximizeResult,
  OptimizableTarget,
} from "@/lib/target-optimizer";
import type {
  Facility,
  Item,
  ItemId,
  ProductionDependencyGraph,
  Recipe,
} from "@/types";
import type {
  CalcSearchCancel,
  CalcSearchOp,
  CalcSearchRequest,
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

/** A worker search job minus transport framing — what the hook hands
 *  `searchMaximize` / `searchFit`. Same shape as `CalcSearchRequest`
 *  without `kind`/`seq`. (Spelled out rather than `Omit`-derived:
 *  `Omit` over the op-discriminated union would collapse the
 *  discriminant and drop the per-op fields.) */
export type SearchRequest = {
  targets: readonly OptimizableTarget[];
  items: readonly Item[];
  recipes: readonly Recipe[];
  facilities: readonly Facility[];
  options: CalculateProductionPlanOptions;
} & CalcSearchOp;

type SearchOutcome = MaximizeResult | FitResult;

/** A running (or parked) search: await `promise`, or `cancel()` to
 *  resolve it with `{ kind: "cancelled" }` at the next probe boundary. */
export interface SearchHandle<R extends SearchOutcome> {
  promise: Promise<R>;
  cancel: () => void;
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

type JobBase = {
  reject: (e: unknown) => void;
  /** Worker deaths this job has survived. Once it reaches
   *  `FALLBACK_AFTER_FAILURES` the job routes to the main-thread
   *  fallback regardless of the global failure budget — the global
   *  counter resets on every successful worker init, so a request
   *  that deterministically crashes a fresh worker would otherwise
   *  retry forever (crash → recreate → ready resets budget → crash). */
  retries: number;
  /** Assigned at dispatch; identifies the worker round-trip. */
  seq?: number;
};

type SolveJob = JobBase & {
  kind: "solve";
  req: CalcRequest;
  resolve: (plan: ProductionDependencyGraph) => void;
};

type SearchJob = JobBase & {
  kind: "search";
  req: SearchRequest;
  resolve: (result: SearchOutcome) => void;
  /** Cooperative-cancellation flag. Worker path: mirrored via a
   *  `cancel-search` control message; fallback path: read directly by
   *  the engines' `isCancelled` closure. */
  cancelled: boolean;
};

type Job = SolveJob | SearchJob;

let worker: Worker | null = null;
let workerReady = false;
let readyPromise: Promise<void> | null = null;
/** Consecutive worker failures; ≥2 → permanent main-thread fallback. */
let workerFailures = 0;
let seqCounter = 0;
let inflight: Job | null = null;
/** Latest-wins parked slot for display solves. */
let pendingSolve: SolveJob | null = null;
/** Single parked slot for searches — dispatched BEFORE a parked solve
 *  (the solve re-runs against the post-search state; running it first
 *  would render a result the search is about to invalidate). */
let pendingSearch: SearchJob | null = null;

const FALLBACK_AFTER_FAILURES = 2;

function shouldFallback(): boolean {
  return (
    typeof Worker === "undefined" || workerFailures >= FALLBACK_AFTER_FAILURES
  );
}

/**
 * Tear down a dead worker and transparently re-dispatch the inflight
 * job. The retried job re-enters `dispatch`, which recreates the
 * worker — or routes to the main-thread fallback once either budget
 * (global `workerFailures` or the job's own `retries`) is exhausted.
 * A search that was cancelled mid-crash resolves `cancelled` instead
 * of being re-run. The parked slots are left alone; they dispatch as
 * usual when the retried job settles. Callers never observe a worker
 * crash directly: they get a result from a fresh worker / the
 * fallback, or the fallback's own error.
 */
function onWorkerDeath(error: unknown) {
  workerFailures++;
  workerReady = false;
  readyPromise = null;
  worker?.terminate();
  worker = null;
  console.warn(
    "[calc-client] calc worker died; retrying on a fresh solver:",
    error,
  );
  const retry = inflight;
  inflight = null;
  if (retry) {
    if (retry.kind === "search" && retry.cancelled) {
      retry.resolve({ kind: "cancelled" });
      dispatchPending();
      return;
    }
    retry.retries++;
    dispatch(retry);
  } else {
    // Defensive: the parked slots are only ever set while a job is
    // inflight, but if that invariant ever breaks, don't strand them.
    dispatchPending();
  }
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
      if (msg.kind === "result" && job.kind === "solve") {
        job.resolve(msg.plan as ProductionDependencyGraph);
      } else if (msg.kind === "search-result" && job.kind === "search") {
        job.resolve(msg.result);
      } else if (msg.kind === "error") {
        job.reject(new Error(msg.message));
      } else {
        // Kind/job mismatch — protocol bug. Fail loudly rather than
        // stranding the caller.
        job.reject(
          new Error(`calc worker protocol mismatch: ${msg.kind}/${job.kind}`),
        );
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

/** Fallback mirror of the worker's search path — same engines, same
 *  direct-solve closure, `isCancelled` polls the job flag. */
async function searchOnMainThread(
  req: SearchRequest,
  isCancelled: () => boolean,
): Promise<SearchOutcome> {
  const [
    { maximizeTargetRate, fitTargetsToLimits },
    { calculateProductionPlan },
    { initHighs },
  ] = await Promise.all([
    import("@/lib/target-optimizer"),
    import("@/lib/calculator"),
    import("@/lib/highs-singleton"),
  ]);
  await initHighs();
  const solve = (vector: Array<{ itemId: ItemId; rate: number }>) =>
    calculateProductionPlan(
      vector,
      req.items,
      req.recipes,
      req.facilities,
      req.options,
    );
  return req.op === "max"
    ? maximizeTargetRate({
        targets: req.targets,
        index: req.index,
        solve,
        isCancelled,
      })
    : fitTargetsToLimits({
        targets: req.targets,
        excludeIndex: req.excludeIndex,
        solve,
        isCancelled,
      });
}

function dispatchPending() {
  if (inflight) return;
  const job: Job | null = pendingSearch ?? pendingSolve;
  if (!job) return;
  if (job.kind === "search") {
    pendingSearch = null;
  } else {
    pendingSolve = null;
  }
  dispatch(job);
}

function dispatch(job: Job) {
  const seq = ++seqCounter;
  job.seq = seq;
  inflight = job;
  // Crash retries re-dispatch the SAME job object with a fresh seq, so
  // identity alone can't tell dispatch generations apart — a stale
  // generation's callback (e.g. the first ensureWorker rejection after
  // `onWorkerDeath` already re-dispatched) must not double-dispatch.
  const isCurrent = () => inflight === job && job.seq === seq;
  if (shouldFallback() || job.retries >= FALLBACK_AFTER_FAILURES) {
    const settle =
      job.kind === "solve"
        ? solveOnMainThread(job.req).then(
            (plan) => () => job.resolve(plan),
            (e) => () => job.reject(e),
          )
        : searchOnMainThread(job.req, () => job.cancelled).then(
            (result) => () => job.resolve(result),
            (e) => () => job.reject(e),
          );
    settle.then((deliver) => {
      if (!isCurrent()) return;
      inflight = null;
      deliver();
      dispatchPending();
    });
    return;
  }
  ensureWorker()
    .then(() => {
      // The worker may have died while we awaited readiness.
      if (!isCurrent()) return;
      // A search cancelled before its message ever left: resolve now —
      // the worker never saw it, so no `cancel-search` would land.
      if (job.kind === "search" && job.cancelled) {
        inflight = null;
        job.resolve({ kind: "cancelled" });
        dispatchPending();
        return;
      }
      if (job.kind === "solve") {
        const msg: CalcSolveRequest = { kind: "solve", seq, ...job.req };
        worker!.postMessage(msg);
      } else {
        const msg: CalcSearchRequest = { kind: "search", seq, ...job.req };
        worker!.postMessage(msg);
      }
    })
    .catch(() => {
      // Construction/init failed — retry this very job through the
      // (possibly fallback) path rather than failing the caller.
      if (!isCurrent()) return;
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
 * parks in the single solve slot, displacing (and rejecting with
 * `CalcSupersededError`) whatever waited there before.
 */
export function calculate(
  req: CalcRequest,
): Promise<ProductionDependencyGraph> {
  return new Promise<ProductionDependencyGraph>((resolve, reject) => {
    const job: SolveJob = { kind: "solve", req, resolve, reject, retries: 0 };
    if (inflight) {
      pendingSolve?.reject(new CalcSupersededError());
      pendingSolve = job;
      return;
    }
    dispatch(job);
  });
}

function startSearch(req: SearchRequest): SearchHandle<SearchOutcome> {
  let job!: SearchJob;
  const promise = new Promise<SearchOutcome>((resolve, reject) => {
    job = { kind: "search", req, resolve, reject, retries: 0, cancelled: false };
    if (inflight) {
      // The hook runs one search at a time, but defend the slot anyway
      // — mirrors the solve slot's latest-wins semantics.
      pendingSearch?.reject(new CalcSupersededError());
      pendingSearch = job;
      return;
    }
    dispatch(job);
  });
  const cancel = () => {
    if (job.cancelled) return;
    job.cancelled = true;
    if (pendingSearch === job) {
      // Never dispatched — settle immediately.
      pendingSearch = null;
      job.resolve({ kind: "cancelled" });
      return;
    }
    if (inflight === job && worker && workerReady) {
      const msg: CalcSearchCancel = { kind: "cancel-search", seq: job.seq! };
      worker.postMessage(msg);
    }
    // Fallback path (and the pre-post window in `dispatch`): the
    // engines / dispatch read `job.cancelled` directly.
  };
  return { promise, cancel };
}

/**
 * Run a priority-Max search in the worker (single job — see the module
 * doc). The cast is sound by construction: an `op: "max"` request only
 * ever resolves with `maximizeTargetRate`'s result type.
 */
export function searchMaximize(
  req: Omit<CalcRequest, "targets"> & {
    targets: readonly OptimizableTarget[];
    index: number;
  },
): SearchHandle<MaximizeResult> {
  return startSearch({ ...req, op: "max" }) as SearchHandle<MaximizeResult>;
}

/** Run a Fit-to-limits search in the worker. Cast soundness mirrors
 *  `searchMaximize` (`op: "fit"` ⇒ `fitTargetsToLimits`'s result). */
export function searchFit(
  req: Omit<CalcRequest, "targets"> & {
    targets: readonly OptimizableTarget[];
    excludeIndex?: number;
  },
): SearchHandle<FitResult> {
  return startSearch({ ...req, op: "fit" }) as SearchHandle<FitResult>;
}

// Dev-only hygiene: every Vite HMR update re-instantiates this module,
// so dispose the outgoing instance's worker — otherwise each hot
// reload orphans a thread holding a full HiGHS WASM instance.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    worker?.terminate();
    worker = null;
    workerReady = false;
    readyPromise = null;
  });
}
