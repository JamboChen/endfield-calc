import { configDefaults, defineConfig, type Plugin } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "child_process";
import fs from "fs";

/**
 * Copy the HiGHS WASM blob into Vite's output `assets/` directory.
 *
 * The `@bubblyworld/highs-ts` package's emscripten-bundled wrapper
 * (`build/highs.js`) loads its WASM via
 *
 *     new URL('highs.wasm', import.meta.url).href
 *
 * inside the bundled JS chunk. Vite emits that JS chunk as
 * `dist/assets/highs-<hash>.js`, so the runtime URL resolves to
 * `dist/assets/highs.wasm` — but Vite has no built-in step that
 * copies the WASM file there. This plugin handles that explicitly.
 *
 * Source: `node_modules/@bubblyworld/highs-ts/build/highs.wasm`.
 * Destination: `<outDir>/assets/highs.wasm` (unhashed; the
 * emscripten wrapper's URL lookup requires the literal filename).
 *
 * Runs on `build` only. Dev mode resolves the WASM via Vite's
 * `node_modules` lookup automatically; tests use node's WASM loader
 * the same way.
 */
function copyHighsWasm(): Plugin {
  return {
    name: "copy-highs-wasm",
    apply: "build",
    writeBundle(options) {
      const srcWasm = path.resolve(
        __dirname,
        "node_modules/@bubblyworld/highs-ts/build/highs.wasm",
      );
      const outDir = options.dir ?? "dist";
      const destWasm = path.resolve(outDir, "assets/highs.wasm");
      if (!fs.existsSync(srcWasm)) {
        throw new Error(
          `[copy-highs-wasm] source WASM missing: ${srcWasm} — run 'bun install' first.`,
        );
      }
      fs.mkdirSync(path.dirname(destWasm), { recursive: true });
      fs.copyFileSync(srcWasm, destWasm);
      const sizeMb = (fs.statSync(destWasm).size / 1024 / 1024).toFixed(2);
      console.log(`[copy-highs-wasm] copied highs.wasm (${sizeMb} MB) -> assets/`);
    },
  };
}

/**
 * Shared test `exclude`. A git worktree checked out inside the repo would
 * otherwise have its tests (from OTHER branches) discovered here and run
 * against this tree's `@`-aliased src.
 */
const TEST_EXCLUDE = [...configDefaults.exclude, "**/.worktrees/**"];

export default defineConfig({
  plugins: [react(), tailwindcss(), copyHighsWasm()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  base: "/endfield-calc/",
  // The calc worker (`src/workers/calc.worker.ts`) dynamically imports
  // the HiGHS emscripten wrapper — module workers with dynamic imports
  // require ES format (the default iife build would fail).
  worker: {
    format: "es",
  },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react")) return "react";
            if (id.includes("lodash")) return "lodash";
            if (id.includes("@xyflow/system")) return "xyflow";
            if (id.includes("elkjs")) return "elkjs";
            if (id.includes("d3-selection") || id.includes("d3-transition"))
              return "d3";
          }
        },
      },
    },
  },
  define: {
    // Inject version and build info as global constants
    __APP_VERSION__: JSON.stringify(getVersion()),
  },
  test: {
    /**
     * Two projects, because the two suites need incompatible setups.
     *
     * The `node` project is the historical suite: pure functions in a
     * Node environment, with HiGHS WASM pre-warmed by `setup.ts`.
     *
     * The `dom` project renders components and hooks under jsdom. It
     * must NOT load `setup.ts`: the HiGHS emscripten wrapper branches on
     * `typeof window`, so under jsdom it would take the browser loader
     * path and try to fetch `highs.wasm` over HTTP. Nothing in the DOM
     * suite solves a plan, so it skips the solver entirely.
     *
     * jsdom rather than a real browser is a deliberate choice: the DOM
     * suite asserts storage writes, state transitions and disabled
     * state — never layout, visibility or focus order. Add a third
     * project on a browser provider the day a test needs to know that
     * something is *visible* rather than merely present.
     *
     * `extends: true` inherits the root `resolve.alias` (`@/…`) and the
     * React plugin; without it neither project could resolve imports.
     *
     * The two `include` globs are keyed on the EXTENSION and together
     * cover every test file under `src/`, so nothing can fall through and
     * be silently uncollected: `.test.ts` → node, `.test.tsx` → dom.
     */
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          exclude: TEST_EXCLUDE,
          // Default 5 s vitest timeout is OK for unit tests but some
          // calculator integration tests run multiple plans and need more
          // headroom. 30 s is generous (typical plans solve well under 1 s)
          // but catches genuinely-stuck tests.
          testTimeout: 30000,
          // Pre-load HiGHS WASM once per worker so solver call sites can
          // run synchronously inside tests. See `src/tests/setup.ts`.
          setupFiles: ["./src/tests/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          exclude: TEST_EXCLUDE,
          setupFiles: ["./src/tests/setup-dom.ts"],
          // Module mocks (`vi.mock`) are created once per FILE, so their
          // call history would otherwise accumulate across the tests in
          // it and turn `toHaveBeenCalledTimes` into a running total.
          // Clearing (not restoring) keeps factory implementations intact.
          clearMocks: true,
        },
      },
    ],
  },
});

function getVersion() {
  try {
    // Try to get version from git describe
    const gitVersion = execSync("git describe --tags --always", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    // If git describe returns a tag, use it
    // Format: v1.0.0 or v1.0.0-3-gabc1234
    return gitVersion;
  } catch {
    // Fallback to package.json version if git is not available
    try {
      const packageJson = JSON.parse(
        fs.readFileSync("./package.json", "utf-8"),
      );
      return `v${packageJson.version}`;
    } catch {
      return "v0.0.0";
    }
  }
}
