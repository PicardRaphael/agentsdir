import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    // each journey spawns the compiled CLI several times plus git
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
