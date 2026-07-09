/**
 * Vitest setup file — runs once per test worker before any test file.
 *
 * Awaits HiGHS WASM init so solver code in test files finds a warm
 * instance without each one re-initialising the WASM module.
 *
 * Wired via `test.setupFiles` in `vite.config.ts`.
 */
import { beforeAll } from "vitest";
import { initHighs } from "@/lib/highs-singleton";

beforeAll(async () => {
  await initHighs();
});
