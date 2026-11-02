import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Rule tests must not depend on wall-clock time, network or test order
    // (AGENTS.md "Testing").
    pool: "forks",
  },
});
