import { defineConfig, type Plugin } from "vitest/config";
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

export default defineConfig({
  plugins: [react(), tailwindcss(), copyHighsWasm()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  base: "/endfield-calc/",
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
    // Default 5 s vitest timeout is OK for unit tests but some
    // calculator integration tests run multiple plans and need more
    // headroom. 30 s is generous (typical plans solve in <100ms with
    // the continuous-LP-relaxation packer) but catches genuinely-stuck
    // tests.
    testTimeout: 30000,
    // Pre-load HiGHS WASM once per worker so solver call sites can run
    // synchronously inside tests. See `src/tests/setup.ts`.
    setupFiles: ["./src/tests/setup.ts"],
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
