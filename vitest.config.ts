import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Vitest defaults to 5 s, which is calibrated for a test that computes.
    // The heaviest tests here install a repository and then run a dozen child
    // processes through it — node and git, one spawn each — and a shared
    // Windows runner takes six to seven times what this machine does: 900 ms
    // locally became 6.5 s in CI, and two tests of the usage pack timed out on
    // a run whose assertions all passed. The bound stays a bound, generous
    // enough that only a test which is truly stuck reaches it.
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      // `text` reads in a CI log, `json-summary` is what a future check would
      // parse. No threshold: TESTING.md rules a blocking percentage out on
      // purpose — the acceptance criteria of the tasks are the bar, and a
      // number would be gamed by tests that execute lines without asserting.
      reporter: ["text", "json-summary", "json"],
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
