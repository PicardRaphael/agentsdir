import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // `text` reads in a CI log, `json-summary` is what a future check would
      // parse. No threshold: TESTING.md rules a blocking percentage out on
      // purpose — the acceptance criteria of the tasks are the bar, and a
      // number would be gamed by tests that execute lines without asserting.
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/__tests__/**",
        "src/test-support/**",
        // vendored icon paths: static data, nothing to execute
        "src/icons/**",
      ],
    },
  },
});
