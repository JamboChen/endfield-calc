import { defineConfig } from "vite";
import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "child_process";
import fs from "fs";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
