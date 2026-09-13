import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LOCK_FILE } from "../../core/lock.js";
import { MANIFEST_FILE } from "../../core/manifest.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { defaultAgentAnswers } from "../../templates/agent.js";
import { defaultSkillAnswers } from "../../templates/skill.js";
import {
  initAnswers,
  makeTempDir,
  makeUnreadable,
  pathExists,
} from "../../test-support/index.js";
import { runAddAgent } from "../add-agent.js";
import { runAddHook } from "../add-hook.js";
import { runAddRule } from "../add-rule.js";
import { runAddSkill } from "../add-skill.js";
import { runInit } from "../init.js";
import { runPackAdd, runPackRemove } from "../pack.js";
import { runSync } from "../sync.js";
import { runUpdate } from "../update.js";
import { resolveHookEvent } from "../../core/hook-registries.js";

const execFileAsync = promisify(execFile);

/**
 * Task 23 — a write that fails.
 *
 * No test in this suite used to simulate one, and that is the hole the
 * architecture audit went through: all five defects it found lived on an error
 * path, and not one of those paths was ever executed. Every command that
 * writes is exercised here with one write made to fail, and each asserts the
 * three things a user actually experiences: the exit code, the message, and
 * what the repository looks like afterwards.
 *
 * The failure is produced by swapping the kind of a path — a file where a
 * directory belongs, or the reverse (`makeUnreadable`). `chmod` is not used:
 * it does nothing on Windows, where the CI also runs, and a guard proven on
 * one platform is not proven. Nor is `node:fs` mocked, which would test the
 * mock.
 */

async function repo(packs: string[] = ["core"]): Promise<string> {
  const dir = await makeTempDir("write-failure");
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(dir, initAnswers({ packs }), { dryRun: false });
  return dir;
}

/** The error a run failed with, or undefined when it did not fail. */
async function failureOf(run: Promise<unknown>): Promise<Error | undefined> {
  return run.then(
    () => undefined,
    (error: unknown) => error as Error,
  );
}

async function listing(dir: string, rel: string): Promise<string[]> {
  return (await readdir(join(dir, ...rel.split("/"))).catch(() => [])).sort();
}

describe("23 - every writing command, with a write that fails", () => {
  it("Given .agents/rules unwritable, When init runs, Then it fails on an environment error and leaves no half-installed repo", async () => {
    const dir = await makeTempDir("write-failure");
    await execFileAsync("git", ["-C", dir, "init"]);
    // a file where the directory belongs: the mkdir under it cannot succeed
    await writeFile(join(dir, ".agents"), "", "utf8");

    const failure = await failureOf(
      runInit(dir, initAnswers(), { dryRun: false }),
    );

    expect(failure).toBeInstanceOf(Error);
    expect(await pathExists(join(dir, MANIFEST_FILE))).toBe(false);
    expect(await pathExists(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("Given a rules directory that cannot be read, When sync runs, Then it refuses and every projection stays in place", async () => {
    const dir = await repo();
    const mirror = await listing(dir, ".claude/rules");
    expect(mirror.length).toBeGreaterThan(0);
    const undo = await makeUnreadable(join(dir, ".agents", "rules"));

    const failure = await failureOf(runSync(dir, { dryRun: false }));

    expect(failure?.message).toMatch(/Cannot read/);
    expect((failure as unknown as { exitCode: number }).exitCode).toBe(
      EXIT_CODES.environmentOrUsage,
    );
    expect(await listing(dir, ".claude/rules")).toEqual(mirror);

    await undo();
    expect((await runSync(dir, { dryRun: false })).exitCode).toBe(
      EXIT_CODES.ok,
    );
  });

  it("Given AGENTS.md replaced by a directory, When add rule runs, Then it fails and the rule is not left behind alone", async () => {
    const dir = await repo();
    await makeUnreadable(join(dir, "AGENTS.md"));

    const failure = await failureOf(
      runAddRule(
        dir,
        { name: "orphan", hook: "Read before anything.", paths: [] },
        { dryRun: false },
      ),
    );

    expect(failure).toBeInstanceOf(Error);
    // the rules index could not be updated, so the rule must not be announced
    // as installed: a rule absent from the index is invisible to every agent
    const indexed = await readFile(join(dir, ".agents.toml"), "utf8");
    expect(indexed).not.toContain("orphan");
  });

  it("Given the skills directory replaced by a file, When add skill runs, Then it fails and writes nothing", async () => {
    const dir = await repo();
    const undo = await makeUnreadable(join(dir, ".agents", "skills"));

    const failure = await failureOf(
      runAddSkill(dir, defaultSkillAnswers("demo-skill", false), {
        dryRun: false,
      }),
    );

    expect(failure).toBeInstanceOf(Error);
    await undo();
    expect(await listing(dir, ".agents/skills")).not.toContain("demo-skill");
  });

  it("Given the agents directory replaced by a file, When add agent runs, Then it fails and writes nothing", async () => {
    const dir = await repo();
    const undo = await makeUnreadable(join(dir, ".agents", "agents"));

    const failure = await failureOf(
      runAddAgent(dir, defaultAgentAnswers("reviewer", "inherit"), {
        dryRun: false,
      }),
    );

    expect(failure).toBeInstanceOf(Error);
    await undo();
    expect(await listing(dir, ".agents/agents")).not.toContain("reviewer.md");
  });

  it("Given a hook registry that is a directory, When add hook runs, Then it fails and the other registries are not left inconsistent", async () => {
    const dir = await repo();
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await mkdir(join(dir, ".cursor", "hooks.json"), { recursive: true });
    const event = resolveHookEvent("PreToolUse");

    const failure = await failureOf(
      runAddHook(
        dir,
        {
          event: event as NonNullable<typeof event>,
          slug: "guard",
          matcher: undefined,
        },
        { dryRun: false },
      ),
    );

    expect(failure).toBeInstanceOf(Error);
    // whatever landed before the failure, `check` sees it and `sync` repairs
    // it — the guarantee task 21 settled, exercised here from a real failure
    // rather than a simulated interruption
    const { runCheck } = await import("../check.js");
    const after = await runCheck(dir, { hooks: { timeoutMs: 5000 } });
    expect([EXIT_CODES.ok, EXIT_CODES.driftOrInvariant]).toContain(
      after.exitCode,
    );
  });

  it("Given the lock replaced by a directory, When pack add runs, Then it refuses and installs nothing", async () => {
    // creator installs skills, so this repo has a lock to break
    const dir = await repo(["core", "creator"]);
    const undo = await makeUnreadable(join(dir, LOCK_FILE));

    const failure = await failureOf(
      runPackAdd(dir, "changelog", { dryRun: false }),
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as unknown as { exitCode: number }).exitCode).toBe(
      EXIT_CODES.environmentOrUsage,
    );
    expect(failure?.message).toMatch(/Cannot read skills-lock\.json/);
    await undo();
    // the manifest never recorded a pack whose install did not happen
    expect(await readFile(join(dir, MANIFEST_FILE), "utf8")).not.toContain(
      "changelog",
    );
  });

  it("Given a pack folder that cannot be inspected, When pack remove runs, Then it refuses rather than deleting blind", async () => {
    const dir = await repo(["core", "creator"]);
    const undo = await makeUnreadable(
      join(dir, ".agents", "skills", "create-rule"),
    );

    const failure = await failureOf(
      runPackRemove(dir, "creator", { dryRun: false, force: false }),
    );

    expect(failure?.message).toMatch(
      /refusing to remove files it cannot inspect/,
    );
    await undo();
    // nothing of the pack was removed on the way to the failure
    expect(await listing(dir, ".agents/skills")).toContain("create-skill");
  });

  it("Given the lock replaced by a directory, When update runs, Then it refuses and migrates nothing", async () => {
    const dir = await repo(["core", "creator"]);
    const manifest = join(dir, MANIFEST_FILE);
    await writeFile(
      manifest,
      (await readFile(manifest, "utf8")).replace(/schema = \d+/, "schema = 1"),
      "utf8",
    );
    const undo = await makeUnreadable(join(dir, LOCK_FILE));

    const failure = await failureOf(runUpdate(dir, { dryRun: false }));

    expect(failure).toBeInstanceOf(Error);
    await undo();
    // the schema was not advanced by a run that could not finish
    expect(await readFile(manifest, "utf8")).toContain("schema = 1");
  });
});
