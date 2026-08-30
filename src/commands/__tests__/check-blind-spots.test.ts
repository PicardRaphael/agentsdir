import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHookEvent } from "../../core/hook-registries.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { runAddHook } from "../add-hook.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runSync } from "../sync.js";

async function repoWithHook(): Promise<string> {
  const dir = await makeTempDir("blind-spots");
  await runInit(dir, initAnswers(), { dryRun: false });
  const event = resolveHookEvent("PreToolUse");
  if (event === undefined) {
    throw new Error("PreToolUse must resolve to a known event");
  }
  await runAddHook(
    dir,
    { event, slug: "guard", matcher: "Bash" },
    { dryRun: false },
  );
  return dir;
}

const hookRule = (violation: { rule: string }): boolean =>
  violation.rule.startsWith("hook-");

/**
 * `check` is the product's only promise: a configuration that does not drift.
 * These are drifts it used to call green.
 */
describe("33 - hook registrations are compared, not just parsed", () => {
  it("Given a repo whose hooks are registered, When check runs, Then it passes", async () => {
    const dir = await repoWithHook();
    const result = await runCheck(dir);
    expect(result.violations.filter(hookRule)).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("Given a hook script added without a sync, When check runs, Then the drift is named — no harness would ever run it", async () => {
    const dir = await repoWithHook();
    await copyFile(
      join(dir, ".agents", "hooks", "pretooluse-guard.mjs"),
      join(dir, ".agents", "hooks", "posttooluse-audit.mjs"),
    );

    const result = await runCheck(dir);

    const violation = result.violations.find(
      (candidate) => candidate.rule === "hook-registration-drift",
    );
    expect(violation).toBeDefined();
    expect(violation?.message).toContain("sync");
    expect(result.exitCode).toBe(1);
  });

  it("Given a hook script deleted without a sync, When check runs, Then the orphan registrations are reported", async () => {
    const dir = await repoWithHook();
    await rm(join(dir, ".agents", "hooks", "pretooluse-guard.mjs"));

    const result = await runCheck(dir);

    expect(
      result.violations.some(
        (candidate) => candidate.rule === "hook-registration-drift",
      ),
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("Given that drift, When sync runs, Then it repairs instead of refusing, and check goes green", async () => {
    // the rule must be repairable: otherwise check says "run sync" and sync
    // refuses, which is the deadlock this project already hit elsewhere
    const dir = await repoWithHook();
    await copyFile(
      join(dir, ".agents", "hooks", "pretooluse-guard.mjs"),
      join(dir, ".agents", "hooks", "posttooluse-audit.mjs"),
    );

    const sync = await runSync(dir, { dryRun: false });

    expect(sync.exitCode).toBe(0);
    expect((await runCheck(dir)).exitCode).toBe(0);
  });

  it("Given a registry that is not valid JSON, When check runs, Then the shape is reported and the comparison is not attempted on it", async () => {
    const dir = await repoWithHook();
    await writeFile(join(dir, ".claude", "settings.json"), "{ broken", "utf8");

    const result = await runCheck(dir);

    expect(
      result.violations.some(
        (candidate) => candidate.rule === "hook-registry-invalid",
      ),
    ).toBe(true);
    expect(
      result.violations.some(
        (candidate) => candidate.rule === "hook-registration-drift",
      ),
    ).toBe(false);
  });

  it("Given a repo with no hooks at all, When check runs, Then nothing is reported", async () => {
    const dir = await makeTempDir("blind-spots-nohooks");
    await runInit(dir, initAnswers(), { dryRun: false });
    await mkdir(join(dir, ".agents", "hooks"), { recursive: true });

    const result = await runCheck(dir);

    expect(result.violations.filter(hookRule)).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("Given a hook registration edited by hand, When check runs, Then the divergence from the scripts is reported", async () => {
    const dir = await repoWithHook();
    const registry = join(dir, ".codex", "hooks.json");
    const parsed = JSON.parse(await readFile(registry, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      registry,
      `${JSON.stringify({ ...parsed, hooks: {} }, null, 2)}\n`,
      "utf8",
    );

    const result = await runCheck(dir);

    expect(
      result.violations.some(
        (candidate) =>
          candidate.rule === "hook-registration-drift" &&
          candidate.path === ".codex/hooks.json",
      ),
    ).toBe(true);
  });
});
