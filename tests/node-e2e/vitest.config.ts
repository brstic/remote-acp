import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 60_000,
    // First run may compile the Rust binaries.
    hookTimeout: 15 * 60_000,
    fileParallelism: false,
    pool: "forks",
  },
});
