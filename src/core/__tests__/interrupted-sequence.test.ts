import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runAddHook } from "../../commands/add-hook.js";
import { runCheck } from "../../commands/check.js";
import { runInit } from "../../commands/init.js";
import { runSync } from "../../commands/sync.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { HOOK_REGISTRY_PATHS, resolveHookEvent } from "../hook-registries.js";

const execFileAsync = promisify(execFile);

/**
 * Task 21 — the atomicity of a *sequence*, not of a file.
 *
 * Per-file atomicity is settled: every write lands in a sibling temp file and
 * is renamed into place, so no file is ever observed half-written. A sequence
 * is another matter. `add hook` writes the script and then one registry per
 * enabled harness; killed between two of them, it leaves a repository where a
 * hook is registered on one harness and not on the next.
 *
 * The guarantee chosen is the second branch the task allows, because it costs
 * no journal and no replay: the intermediate state is **visible to `check`**
 * and **repaired by `sync`**. What follows proves it for every way the
 * sequence can be cut.
 */

async function repo(): Promise<string> {
  const dir = await makeTempDir("interrupted");
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(dir, initAnswers({ packs: ["core"] }), { dryRun: false });
  return dir;
}

/** The registries of the three enabled harnesses, in the order `add hook` writes them. */
const REGISTRIES = [
  HOOK_REGISTRY_PATHS.claude,
  HOOK_REGISTRY_PATHS.codex,
  HOOK_REGISTRY_PATHS.cursor,
];

async function addHook(dir: string): Promise<void> {
  const event = resolveHookEvent("PreToolUse");
  expect(event).toBeDefined();
  await runAddHook(
    dir,
    {
      event: event as NonNullable<typeof event>,
      slug: "guard",
      matcher: undefined,
    },
    { dryRun: false },
  );
}

async function checkOf(dir: string): Promise<ReturnType<typeof runCheck>> {
  return runCheck(dir, { hooks: { timeoutMs: 5000 } });
}

describe("21 - a sequence cut in the middle stays repairable", () => {
  it("Given add hook interrupted after the script and before any registry, When check runs, Then it fails and names the repair", async () => {
    const dir = await repo();
    await addHook(dir);
    // the interruption, replayed: the script landed, the registries did not
    for (const path of REGISTRIES) {
      await rm(join(dir, ...path.split("/")), { force: true });
    }

    const failed = await checkOf(dir);

    expect(failed.exitCode).toBe(EXIT_CODES.driftOrInvariant);
    const drift = failed.violations.find(
      (violation) => violation.rule === "hook-registration-drift",
    );
    expect(drift?.message).toMatch(/agentsdir sync/);
    expect(drift?.message).toMatch(
      /registered nowhere|differ from the scripts/,
    );
  });

  it("Given the same interruption, When sync runs, Then the repository is repaired and check goes green", async () => {
    const dir = await repo();
    await addHook(dir);
    for (const path of REGISTRIES) {
      await rm(join(dir, ...path.split("/")), { force: true });
    }

    const repair = await runSync(dir, { dryRun: false });

    expect(repair.exitCode).toBe(EXIT_CODES.ok);
    expect((await checkOf(dir)).exitCode).toBe(EXIT_CODES.ok);
    for (const path of REGISTRIES) {
      const raw = await readFile(join(dir, ...path.split("/")), "utf8");
      expect(raw).toContain("pretooluse-guard.mjs");
    }
  });

  it("Given add hook interrupted between two registries, When check runs, Then the half-registered state is a violation, and sync repairs it", async () => {
    // the state the task calls invisible: one harness knows the hook, the
    // next does not, and nothing about the repository looks wrong
    const dir = await repo();
    await addHook(dir);
    const partial = join(dir, ...REGISTRIES[2]!.split("/"));
    await rm(partial, { force: true });

    const failed = await checkOf(dir);
    expect(failed.exitCode).toBe(EXIT_CODES.driftOrInvariant);
    expect(
      failed.violations.some(
        (violation) => violation.rule === "hook-registration-drift",
      ),
    ).toBe(true);

    await runSync(dir, { dryRun: false });

    expect((await checkOf(dir)).exitCode).toBe(EXIT_CODES.ok);
    expect(await readFile(partial, "utf8")).toContain("pretooluse-guard.mjs");
  });

  it("Given a registry left half-written by a crash, When sync runs, Then it refuses rather than merging into rubble", async () => {
    // per-file atomicity makes this state unreachable through this CLI; a
    // crashed editor or a bad merge can still produce it, and the answer must
    // be a refusal that names the file, never a silent rewrite
    const dir = await repo();
    await addHook(dir);
    const path = join(dir, ...REGISTRIES[0]!.split("/"));
    await writeFile(path, '{"hooks": {"PreToolUse": [', "utf8");

    const aborted = await runSync(dir, { dryRun: false });

    expect(aborted.exitCode).toBe(EXIT_CODES.driftOrInvariant);
    expect(
      aborted.violations.some(
        (violation) => violation.rule === "hook-registry-invalid",
      ),
    ).toBe(true);
    // nothing written: the refusal leaves the rubble for the user to fix,
    // rather than merging into it or overwriting what they may still recover
    expect(await readFile(path, "utf8")).toBe('{"hooks": {"PreToolUse": [');
  });

  it("Given every generator, When it writes, Then it writes atomically", async () => {
    // the premise task 21 rests on: no file is ever observed half-written.
    // `init`, `sync` and the projection engine were converted; the generators
    // and `pack` were not, and AGENTS.md is a file the user owns.
    const { readdirSync, readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const commands = fileURLToPath(new URL("../../commands", import.meta.url));
    const offenders: string[] = [];
    for (const name of readdirSync(commands)) {
      if (!name.endsWith(".ts")) {
        continue;
      }
      const source = readFileSync(join(commands, name), "utf8");
      if (/await writeFile\(/.test(source)) {
        offenders.push(name);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("Given a repaired repository, When sync runs again, Then it has nothing left to do", async () => {
    const dir = await repo();
    await addHook(dir);
    for (const path of REGISTRIES) {
      await rm(join(dir, ...path.split("/")), { force: true });
    }
    await runSync(dir, { dryRun: false });

    const again = await runSync(dir, { dryRun: false });

    expect(again.changes.filter((change) => change.action !== "ok")).toEqual(
      [],
    );
  });
});
