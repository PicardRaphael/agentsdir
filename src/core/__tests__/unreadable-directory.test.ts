import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCheck } from "../../commands/check.js";
import { runDoctor } from "../../commands/doctor.js";
import { runInit } from "../../commands/init.js";
import { runSync } from "../../commands/sync.js";
import { EXIT_CODES } from "../../exit-codes.js";
import {
  initAnswers,
  makeTempDir,
  makeUnreadable,
} from "../../test-support/index.js";
import { readdirOrEmpty } from "../fs-utils.js";

const srcRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * A repository whose only harness is Codex: nothing is projected, so `check`
 * reaches the invariants that read `.agents/` directly — the ones that used to
 * swallow an unreadable directory. In copy mode the projection engine refuses
 * first and the hole stays hidden, which is exactly how it survived.
 */
async function codexOnlyRepo(): Promise<string> {
  const dir = await makeTempDir("unreadable");
  await runInit(
    dir,
    initAnswers({ harnesses: ["codex", "cursor"], packs: ["core"] }),
    { dryRun: false },
  );
  return dir;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "test-support") {
        found.push(...sourceFiles(path));
      }
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

/**
 * An absent directory and an unreadable one must never look alike. Reading both
 * as "empty" made `sync` delete the projections of the files it could no longer
 * see — and exit 0 while doing it, with `check` green afterwards. Silent data
 * loss in a tool whose whole promise is that nothing drifts unnoticed.
 */
describe("core - an unreadable directory is not an empty one", () => {
  it("Given a directory that does not exist, When it is listed, Then the answer is an empty list", async () => {
    const dir = await makeTempDir("unreadable");
    expect(await readdirOrEmpty(join(dir, "nowhere"))).toEqual([]);
  });

  it("Given a path that is not a directory, When it is listed, Then it refuses with a usage error naming the path", async () => {
    const dir = await makeTempDir("unreadable");
    const path = join(dir, "a-file");
    await writeFile(path, "not a directory\n", "utf8");
    await expect(readdirOrEmpty(path)).rejects.toMatchObject({
      exitCode: EXIT_CODES.environmentOrUsage,
    });
    await expect(readdirOrEmpty(path)).rejects.toThrow(/Cannot read/);
  });

  it("Given .agents/rules made unreadable, When sync runs, Then it refuses and leaves every projection in place", async () => {
    const dir = await makeTempDir("unreadable");
    await runInit(dir, initAnswers(), { dryRun: false });
    const mirror = join(dir, ".claude", "rules");
    const before = (await readdir(mirror)).sort();
    expect(before.length).toBeGreaterThan(0);

    // a file where the directory belongs: unreadable, not absent
    const rules = join(dir, ".agents", "rules");
    await rename(rules, `${rules}-moved`);
    await writeFile(rules, "", "utf8");

    const result = await runSync(dir, { dryRun: false }).catch(
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Cannot read/);
    expect((await readdir(mirror)).sort()).toEqual(before);

    // once the cause is fixed, the repo is healthy again
    await rm(rules);
    await rename(`${rules}-moved`, rules);
    await mkdir(rules, { recursive: true });
    expect((await runSync(dir, { dryRun: false })).exitCode).toBe(
      EXIT_CODES.ok,
    );
  });

  it("Given .agents/agents made unreadable, When check runs, Then it refuses instead of passing green on sub-agents it never saw", async () => {
    // the defect, exactly: `check` used to read the unreadable directory as
    // "no sub-agents", print "Check passed" and exit 0 — a CI gate going green
    // on a repository it could not see
    const dir = await codexOnlyRepo();
    const undo = await makeUnreadable(join(dir, ".agents", "agents"));

    const failure = await runCheck(dir).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toMatch(/Cannot read/);
    expect(failure?.message).toMatch(/sub-agents it cannot list/);
    expect((failure as unknown as { exitCode: number }).exitCode).toBe(
      EXIT_CODES.environmentOrUsage,
    );

    await undo();
    expect((await runCheck(dir)).exitCode).toBe(EXIT_CODES.ok);
  });

  it("Given .agents/skills made unreadable, When check runs, Then it refuses rather than validating a skill set it cannot list", async () => {
    const dir = await codexOnlyRepo();
    const undo = await makeUnreadable(join(dir, ".agents", "skills"));

    const failure = await runCheck(dir).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toMatch(/skills it cannot list/);
    expect((failure as unknown as { exitCode: number }).exitCode).toBe(
      EXIT_CODES.environmentOrUsage,
    );

    await undo();
    expect((await runCheck(dir)).exitCode).toBe(EXIT_CODES.ok);
  });

  it("Given .agents/skills made unreadable, When doctor runs, Then it reports the fault instead of billing the budget at zero", async () => {
    // doctor is the command a user runs *because* something is broken: it must
    // stay usable, and it must not answer with a budget it could not measure
    const dir = await codexOnlyRepo();
    await makeUnreadable(join(dir, ".agents", "skills"));

    const result = await runDoctor(dir);

    const budget = result.findings.find(
      (finding) => finding.rule === "context-budget",
    );
    expect(budget?.severity).toBe("error");
    expect(budget?.message).toMatch(/Cannot read/);
    expect(result.context).toBeNull();
    expect(result.exitCode).toBe(EXIT_CODES.ok);
  });

  it("Given the source tree, When it is scanned, Then no module reads a directory outside the one helper that tells absence from failure", async () => {
    // the guard: every `readdir` that swallowed its error was a silent hole,
    // and four of them coexisted. New ones must pass through fs-utils, whose
    // contract makes the distinction impossible to forget.
    const allowed = new Map([
      // the helper itself, and the single recursive walk it hosts
      ["core/fs-utils.ts", "the helper"],
      // best effort by contract: emptied sub-folders of a mirror that is being
      // cleaned up, inside a try/catch that documents the tolerance
      ["core/projections.ts", "removeIfNoFilesLeft, best effort by contract"],
    ]);
    const offenders = sourceFiles(srcRoot)
      .filter((file) => /\breaddir\(/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(srcRoot.length).split("\\").join("/"))
      .filter((file) => !allowed.has(file));

    expect(offenders).toEqual([]);
  });
});
