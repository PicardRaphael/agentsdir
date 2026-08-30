import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectSymlinkSupport } from "../../core/detect.js";
import { resolveHookEvent } from "../../core/hook-registries.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { runAddHook } from "../add-hook.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runSync } from "../sync.js";

const symlinkProbe = await makeTempDir("blind-spots-probe");
const symlinkSupported = (await detectSymlinkSupport(symlinkProbe)).supported;

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

/**
 * Rewrites the first prose line of a rule — the one `sync` lifts into the
 * index as "when to read it". The heading is left alone.
 */
function withNewPurpose(source: string): string {
  const lines = source.split("\n");
  const index = lines.findIndex(
    (line) => line.trim() !== "" && !line.startsWith("#"),
  );
  if (index === -1) {
    throw new Error("the rule has no prose line to rewrite");
  }
  lines[index] = "Read before touching anything at all.";
  return lines.join("\n");
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

describe("33 - what the harness loads but check never read", () => {
  it.runIf(symlinkSupported)(
    "Given a skill folder that is a symlink, When check runs, Then it is reported instead of skipped in silence",
    async () => {
      // a Dirent for a symlink answers false to isDirectory(), so the folder
      // was skipped — while the harness follows the link and loads it
      const outside = await makeTempDir("blind-spots-skill-outside");
      await writeFile(
        join(outside, "SKILL.md"),
        ["---", "name: ghost", "description: never validated", "---", ""].join(
          "\n",
        ),
        "utf8",
      );
      const dir = await makeTempDir("blind-spots-linked-skill");
      await runInit(dir, initAnswers(), { dryRun: false });
      await symlink(outside, join(dir, ".agents", "skills", "ghost"), "dir");

      const result = await runCheck(dir);

      const violation = result.violations.find(
        (candidate) => candidate.rule === "skill-symlinked",
      );
      expect(violation?.path).toBe(".agents/skills/ghost");
      expect(result.exitCode).toBe(1);
    },
  );

  it.runIf(symlinkSupported)(
    "Given a sub-agent file that is a symlink, When check runs, Then it is reported too",
    async () => {
      const outside = await makeTempDir("blind-spots-agent-outside");
      const target = join(outside, "ghost.md");
      await writeFile(
        target,
        [
          "---",
          "name: ghost",
          'description: "never validated"',
          "---",
          "",
        ].join("\n"),
        "utf8",
      );
      const dir = await makeTempDir("blind-spots-linked-agent");
      await runInit(dir, initAnswers(), { dryRun: false });
      await mkdir(join(dir, ".agents", "agents"), { recursive: true });
      await symlink(target, join(dir, ".agents", "agents", "ghost.md"));

      const result = await runCheck(dir);

      expect(
        result.violations.some(
          (candidate) => candidate.rule === "agent-symlinked",
        ),
      ).toBe(true);
    },
  );
});

describe("33 - the rules index is compared to its render, not searched for paths", () => {
  it("Given a rule whose first line changed since the last sync, When check runs, Then the stale text is reported", async () => {
    // sync regenerates "path — when to read it" from that first line; checking
    // that the path appears could never see the description going stale
    const dir = await makeTempDir("blind-spots-index");
    await runInit(dir, initAnswers(), { dryRun: false });
    const rule = join(dir, ".agents", "rules", "tasks.md");
    const before = await readFile(rule, "utf8");
    await writeFile(rule, withNewPurpose(before), "utf8");

    const result = await runCheck(dir);

    const violation = result.violations.find(
      (candidate) =>
        candidate.rule === "rules-index-out-of-sync" &&
        candidate.path === "AGENTS.md",
    );
    expect(violation?.message).toContain("not the right text");
    expect(result.exitCode).toBe(1);
  });

  it("Given that stale text, When sync runs, Then the index is regenerated and check goes green", async () => {
    const dir = await makeTempDir("blind-spots-index-repair");
    await runInit(dir, initAnswers(), { dryRun: false });
    const rule = join(dir, ".agents", "rules", "tasks.md");
    const before = await readFile(rule, "utf8");
    await writeFile(rule, withNewPurpose(before), "utf8");

    await runSync(dir, { dryRun: false });

    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain(
      "touching anything at all",
    );
    expect((await runCheck(dir)).exitCode).toBe(0);
  });
});

describe("33 - a projection with no source is seen, and removed", () => {
  it("Given a skill folder dropped into .claude/skills with no source, When check runs, Then it is reported as an orphan", async () => {
    // scanning only the recorded fingerprints left this whole class invisible:
    // no source, no hash, no pass reads it — while the harness loads it
    const dir = await makeTempDir("blind-spots-intruder");
    await runInit(dir, initAnswers(), { dryRun: false });
    await mkdir(join(dir, ".claude", "skills", "intruder"), {
      recursive: true,
    });
    await writeFile(
      join(dir, ".claude", "skills", "intruder", "SKILL.md"),
      ["---", "name: intruder", "description: dropped in", "---", ""].join(
        "\n",
      ),
      "utf8",
    );

    const result = await runCheck(dir);

    const violation = result.violations.find(
      (candidate) =>
        candidate.path === ".claude/skills/intruder/SKILL.md" &&
        candidate.rule === "projection-orphan",
    );
    expect(violation?.message).toContain("no source in .agents/");
    expect(result.exitCode).toBe(1);
  });

  it("Given that orphan, When sync runs, Then it is removed with its empty folders, and the real skills stay", async () => {
    // check must never point at a sync that does not repair
    const dir = await makeTempDir("blind-spots-intruder-repair");
    await runInit(dir, initAnswers(), { dryRun: false });
    await mkdir(join(dir, ".claude", "skills", "intruder", "assets"), {
      recursive: true,
    });
    await writeFile(
      join(dir, ".claude", "skills", "intruder", "SKILL.md"),
      ["---", "name: intruder", "description: dropped in", "---", ""].join(
        "\n",
      ),
      "utf8",
    );

    const before = await readdir(join(dir, ".claude", "skills"));

    await runSync(dir, { dryRun: false });

    const left = await readdir(join(dir, ".claude", "skills"));
    expect(left).not.toContain("intruder");
    // everything that was legitimately there is still there: the pruning
    // removes what has no source, not the projected directory itself
    expect(left).toEqual(before.filter((entry) => entry !== "intruder"));
    expect((await runCheck(dir)).exitCode).toBe(0);
  });
});
