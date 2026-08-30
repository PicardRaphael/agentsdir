import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../../commands/check.js";
import { runInit } from "../../commands/init.js";
import { runSync } from "../../commands/sync.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";

/**
 * `check` and `sync` must agree on what a valid repository is. They did not:
 * `validateRepo` never looked at the hook registries, so a malformed
 * `.claude/settings.json` passed CI green while `sync` refused to run — the
 * worst kind of disagreement, since CI is what people trust.
 */
async function initializedRepo(): Promise<string> {
  const dir = await makeTempDir("registry-parity");
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

describe("check and sync agree on hook registries", () => {
  it("Given a registry holding an array, When check runs, Then it fails like sync does", async () => {
    const dir = await initializedRepo();
    await writeFile(join(dir, ".claude", "settings.json"), "[]\n", "utf8");

    const check = await runCheck(dir);
    expect(check.exitCode).toBe(EXIT_CODES.driftOrInvariant);
    expect(check.violations.map((violation) => violation.rule)).toContain(
      "hook-registry-invalid",
    );
  });

  it("Given a registry that is not JSON, When check runs, Then it names the file and the fix", async () => {
    const dir = await initializedRepo();
    await writeFile(join(dir, ".claude", "settings.json"), "{ nope\n", "utf8");

    const violation = (await runCheck(dir)).violations.find(
      (candidate) => candidate.rule === "hook-registry-invalid",
    );
    expect(violation?.path).toBe(".claude/settings.json");
    expect(violation?.message).toMatch(/not valid JSON/);
  });

  it("Given a well-formed registry, When check runs, Then it stays green and sync agrees", async () => {
    const dir = await initializedRepo();
    await writeFile(
      join(dir, ".claude", "settings.json"),
      '{\n  "hooks": {}\n}\n',
      "utf8",
    );

    expect((await runCheck(dir)).exitCode).toBe(EXIT_CODES.ok);
    expect((await runSync(dir, { dryRun: false })).exitCode).toBe(
      EXIT_CODES.ok,
    );
  });
});
