import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // All DB tests share one throwaway lab test database; run files sequentially
    // so per-test resets cannot interleave.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: ["tests/global-setup.ts"],
  },
});
