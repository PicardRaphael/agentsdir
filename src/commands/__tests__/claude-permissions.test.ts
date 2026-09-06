import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CLAUDE_SETTINGS_FILE } from "../../core/claude-permissions.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
  runCli,
} from "../../test-support/index.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runPackAdd, runPackRemove } from "../pack.js";
import { runSync } from "../sync.js";

const execFileAsync = promisify(execFile);

/**
 * Four documents promised a managed permissions block in
 * `.claude/settings.json` — `docs/commandes.md` twice, `docs/harness.md`,
 * `docs/architecture.md` — and no code wrote one. The packs install skills
 * whose procedure tells the agent to run a script; with no rule, Claude Code
 * asks every time: the cascading prompts `architecture.md` lists among the
 * flaws this CLI was built to fix.
 */
const VERIFY_RULE =
  "Bash(node .agents/skills/verify/scripts/build-report.mjs *)";

async function settingsOf(dir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(
    join(dir, ...CLAUDE_SETTINGS_FILE.split("/")),
    "utf8",
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

function allowOf(settings: Record<string, unknown>): string[] {
  const permissions = settings["permissions"] as
    { allow?: string[] } | undefined;
  return permissions?.allow ?? [];
}

async function repo(prefix: string, packs: string[]): Promise<string> {
  const dir = await makeTempDir(prefix);
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(dir, initAnswers({ packs }), { dryRun: false });
  return dir;
}

describe("35 - the .claude/settings.json permissions block", () => {
  it("Given a pack that installs a script, When init runs, Then the allowlist covers it and check stays green", async () => {
    const dir = await repo("permissions-init", ["core", "verification"]);

    expect(allowOf(await settingsOf(dir))).toEqual([VERIFY_RULE]);
    expect((await runCheck(dir)).exitCode).toBe(0);
  });

  it("Given no pack installing a script, When init runs, Then no settings file is created at all", async () => {
    const dir = await repo("permissions-none", ["core"]);

    expect(
      await pathExists(join(dir, ...CLAUDE_SETTINGS_FILE.split("/"))),
    ).toBe(false);
  });

  it("Given `pack add verification`, When it runs, Then the rule is there immediately, without waiting for a sync", async () => {
    // the exact reproduction from the task: the pack laid down a script its
    // SKILL.md runs through node, with no permission anywhere
    const dir = await repo("permissions-pack-add", ["core"]);

    const result = await runPackAdd(dir, "verification", { dryRun: false });

    expect(allowOf(await settingsOf(dir))).toEqual([VERIFY_RULE]);
    expect(result.changes.map((change) => change.path)).toContain(
      CLAUDE_SETTINGS_FILE,
    );
  });

  it("Given `pack remove`, When it runs, Then the rules of the departed scripts go with it", async () => {
    const dir = await repo("permissions-pack-remove", ["core", "worktrees"]);
    expect(allowOf(await settingsOf(dir)).length).toBe(3);

    await runPackRemove(dir, "worktrees", { force: false, dryRun: false });

    expect(
      await pathExists(join(dir, ...CLAUDE_SETTINGS_FILE.split("/"))),
    ).toBe(true);
    expect(allowOf(await settingsOf(dir))).toEqual([]);
  });

  it("Given rules and keys the user wrote, When sync runs, Then everything outside our rules is preserved", async () => {
    const dir = await repo("permissions-user", ["core", "verification"]);
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, ...CLAUDE_SETTINGS_FILE.split("/")),
      `${JSON.stringify(
        {
          model: "opus",
          permissions: {
            allow: ["Bash(npm run lint)"],
            deny: ["Read(./.env)"],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await runSync(dir, { dryRun: false });

    const settings = await settingsOf(dir);
    expect(settings["model"]).toBe("opus");
    const permissions = settings["permissions"] as {
      allow: string[];
      deny: string[];
    };
    expect(permissions.deny).toEqual(["Read(./.env)"]);
    // the user rule keeps its place, ours is appended after it
    expect(permissions.allow).toEqual(["Bash(npm run lint)", VERIFY_RULE]);
  });

  it("Given the block was deleted by hand, When sync runs, Then it is put back and a second sync reports no change", async () => {
    const dir = await repo("permissions-restore", ["core", "verification"]);
    await rm(join(dir, ...CLAUDE_SETTINGS_FILE.split("/")));

    const repaired = await runSync(dir, { dryRun: false });

    expect(allowOf(await settingsOf(dir))).toEqual([VERIFY_RULE]);
    expect(
      repaired.changes.find((change) => change.path === CLAUDE_SETTINGS_FILE)
        ?.action,
    ).toBe("created");
    const again = await runSync(dir, { dryRun: false });
    expect(
      again.changes.find((change) => change.path === CLAUDE_SETTINGS_FILE)
        ?.action,
    ).toBe("ok");
  });

  it("Given hooks registered in the same file, When sync runs, Then the registrations and the permissions live side by side", async () => {
    // both write `.claude/settings.json`: two plans for one path would clobber
    // each other, so they are merged into one
    const dir = await repo("permissions-hooks", ["core", "verification"]);

    await runCli(dir, ["add", "hook", "PreToolUse", "--name", "guard"]);
    await runSync(dir, { dryRun: false });

    const settings = await settingsOf(dir);
    expect(allowOf(settings)).toEqual([VERIFY_RULE]);
    const hooks = settings["hooks"] as Record<string, unknown[]>;
    expect(hooks["PreToolUse"]?.length).toBe(1);
    expect((await runCheck(dir)).exitCode).toBe(0);
  });
});
