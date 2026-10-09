import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 1_320_000,
    hookTimeout: 120_000,
    // Real Chromium + a shared daemon: keep it serial and predictable.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
