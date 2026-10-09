import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/cli/index.ts",
    bridge: "src/bridge/index.ts",
    test: "src/test/index.ts",
    "daemon/entry": "src/daemon/entry.ts",
  },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node24",
  dts: true,
  clean: true,
  sourcemap: false,
  // Emit `.js`/`.d.ts` so the paths in package.json `bin`/`exports` are exact.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  // Dependencies stay external: resolved from node_modules at runtime. The
  // browser bridge must never inline Node builtins or an engine runtime.
  deps: {
    neverBundle: ["playwright", "@playwright/test", "commander", "zod"],
  },
});
