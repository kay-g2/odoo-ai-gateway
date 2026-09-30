import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
    // Every test must run offline: see test/setup.ts, which makes any real network access throw.
    testTimeout: 10_000,
  },
});
