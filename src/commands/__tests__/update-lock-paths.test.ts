import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LOCK_FILE } from "../../core/lock.js";
import { MANIFEST_FILE } from "../../core/manifest.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { runInit } from "../init.js";
import { runUpdate } from "../update.js";

const execFileAsync = promisify(execFile);

/**
 * What `update` reads before it writes anything.
 *
 * The command rebuilds its picture of the repository from `skills-lock.json`,
 * and every way that file can disagree with the disk has its own branch: an
 * entry naming a pack the repository no longer declares, a locked folder that
 * is gone, a key that is not a name. None of them had a test, and they guard
 * the command that *replaces installed content* — the one place where reading
 * the situation wrong costs the user their edits.
 *
 * Each case asserts the same three things: the exit, the sentence, and that the
 * repository is untouched. A refusal that has already written half a migration
 * is not a refusal.
 */

async function repo(packs: string[]): Promise<string> {
  const dir = await makeTempDir("update-lock");
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(dir, initAnswers({ packs }), { dryRun: false });
  return dir;
}

async function failureOf(run: Promise<unknown>): Promise<Error | undefined> {
  return run.then(
    () => undefined,
    (error: unknown) => error as Error,
  );
}

async function editLock(
  dir: string,
  mutate: (lock: Record<string, unknown>) => unknown,
): Promise<void> {
  const path = join(dir, LOCK_FILE);
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(path, JSON.stringify(mutate(parsed), null, 2), "utf8");
}

/** The manifest, so a test can prove the run wrote nothing into it. */
async function manifestOf(dir: string): Promise<string> {
  return readFile(join(dir, MANIFEST_FILE), "utf8");
}

describe("update - a lock that disagrees with the disk", () => {
  it("Given a lock that is not JSON, When update runs, Then it refuses by name and migrates nothing", async () => {
    const dir = await repo(["core", "creator"]);
    const before = await manifestOf(dir);
    await writeFile(join(dir, LOCK_FILE), "{ broken", "utf8");

    const failure = await failureOf(runUpdate(dir, { dryRun: false }));

    expect(failure?.message).toBe(
      "skills-lock.json is not valid JSON — restore it from git history.",
    );
    expect((failure as unknown as { exitCode: number }).exitCode).toBe(
      EXIT_CODES.driftOrInvariant,
    );
    expect(await manifestOf(dir)).toBe(before);
  });

  it("Given a locked skill folder that was deleted, When update runs, Then it names both repairs and writes nothing", async () => {
    const dir = await repo(["core", "creator"]);
    const before = await manifestOf(dir);
    await rm(join(dir, ".agents", "skills", "create-rule"), {
      recursive: true,
      force: true,
    });

    const failure = await failureOf(runUpdate(dir, { dryRun: false }));

    expect(failure?.message).toBe(
      "Locked skill folder .agents/skills/create-rule/ is missing — restore it, or drop its entry from skills-lock.json. Nothing was written.",
    );
    expect((failure as unknown as { exitCode: number }).exitCode).toBe(
      EXIT_CODES.driftOrInvariant,
    );
    expect(await manifestOf(dir)).toBe(before);
  });

  it("Given a locked file that was deleted, When update runs, Then it names the file rather than the folder", async () => {
    const dir = await repo(["core", "verification"]);
    const rule = join(dir, ".agents", "rules", "verification.md");
    await rm(rule, { force: true });

    const failure = await failureOf(runUpdate(dir, { dryRun: false }));

    expect(failure?.message).toBe(
      "Locked file .agents/rules/verification.md is missing — restore it, or drop its entry from skills-lock.json. Nothing was written.",
    );
    expect((failure as unknown as { exitCode: number }).exitCode).toBe(
      EXIT_CODES.driftOrInvariant,
    );
  });

  it("Given a lock key that is a path, When update runs, Then it refuses before reading anything and the traversal never happens", async () => {
    // two guards in a row: `validateRepo` refuses the key and stops the run,
    // and the loop that would use it as a path segment refuses it again. Only
    // the first is observable — the second is a belt over braces, kept because
    // a future caller of that loop may not validate first
    const dir = await repo(["core", "creator"]);
    await editLock(dir, (lock) => ({
      ...lock,
      skills: {
        ...(lock["skills"] as Record<string, unknown>),
        "../../escape": {
          source: "agentsdir",
          sourceType: "agentsdir",
          installedVersion: "1.0.0",
          computedHash: "deadbeef",
        },
      },
    }));

    const result = await runUpdate(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
    expect(
      result.violations.some(
        (violation) =>
          violation.rule === "lock-invalid" &&
          violation.message.includes("../../escape"),
      ),
    ).toBe(true);
    // and nothing outside the repository was planned, written or reported
    expect(
      result.changes.some((change) => change.path.includes("escape")),
    ).toBe(false);
  });

  it("Given a locked skill whose pack the repository no longer declares, When update runs, Then it is left alone rather than migrated", async () => {
    // a pack removed from the manifest by hand, its content still on disk: the
    // lock still names the skill, and `update` has no upstream to compare it
    // to — touching it would mean rewriting content from a pack the repository
    // has stopped asking for
    const dir = await repo(["core", "creator"]);
    const manifest = join(dir, MANIFEST_FILE);
    await writeFile(
      manifest,
      (await readFile(manifest, "utf8")).replace(
        /installed = \[[^\]]*\]/,
        'installed = [ "core" ]',
      ),
      "utf8",
    );
    const skill = join(dir, ".agents", "skills", "create-rule", "SKILL.md");
    const content = await readFile(skill, "utf8");

    const result = await runUpdate(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    // the skill is still reported — it is on disk and `sync` still mirrors it —
    // but every line about it is "ok": nothing of an undeclared pack is rewritten
    expect(
      result.changes
        .filter((change) => change.path.includes("create-rule"))
        .every((change) => change.action === "ok"),
    ).toBe(true);
    expect(await readFile(skill, "utf8")).toBe(content);
  });

  it("Given a locked file whose pack the repository no longer declares, When update runs, Then it is left alone too", async () => {
    const dir = await repo(["core", "verification"]);
    const manifest = join(dir, MANIFEST_FILE);
    await writeFile(
      manifest,
      (await readFile(manifest, "utf8")).replace(
        /installed = \[[^\]]*\]/,
        'installed = [ "core" ]',
      ),
      "utf8",
    );
    const rule = join(dir, ".agents", "rules", "verification.md");
    const content = await readFile(rule, "utf8");

    const result = await runUpdate(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(await readFile(rule, "utf8")).toBe(content);
  });
});
