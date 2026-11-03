import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // Only this package's tests (sample-project/ has its own node:test suite).
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    // The first run may compile the Rust relay + test desktop.
    hookTimeout: 15 * 60_000,
    fileParallelism: false,
    pool: "forks",
  },
});
