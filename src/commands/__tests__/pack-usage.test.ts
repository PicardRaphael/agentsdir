import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HOOK_PROBE_SESSION_ID } from "../../core/hook-protocol.js";
import { resolveHookEvent } from "../../core/hook-registries.js";
import { readManifest } from "../../core/manifest.js";
import { USAGE_JOURNAL_DIR } from "../../core/usage-journal.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
} from "../../test-support/index.js";
import { runAddHook } from "../add-hook.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runPackAdd, runPackRemove } from "../pack.js";

const execFileAsync = promisify(execFile);

/**
 * Task 25 — the collection stage of the `usage` pack. It observes and stops
 * there: every assertion below is about what reaches the journal, and above
 * all about what never does. The repository this installs into may be private,
 * a client's, or under NDA.
 */

const HOOK_FILES = [
  "pretooluse-usage.mjs",
  "sessionstart-usage.mjs",
  "sessionend-usage.mjs",
  "subagentstart-usage.mjs",
  "subagentstop-usage.mjs",
];

interface JournalLine {
  ts: string;
  event: string;
  tool: string | null;
  path: string | null;
  skill: string | null;
  agent: string | null;
  session: string | null;
}

async function repoWithUsage(): Promise<string> {
  const dir = await makeTempDir("pack-usage");
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(dir, initAnswers({ packs: ["core"] }), { dryRun: false });
  await runPackAdd(dir, "usage", { dryRun: false });
  return dir;
}

/** The same install, keeping the report so its actions can be inspected. */
async function repoWithUsageReport(): Promise<{
  dir: string;
  changes: { path: string; action: string }[];
}> {
  const dir = await makeTempDir("pack-usage");
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(dir, initAnswers({ packs: ["core"] }), { dryRun: false });
  const result = await runPackAdd(dir, "usage", { dryRun: false });
  return { dir, changes: result.changes };
}

/** Runs one hook script the way a harness does: one JSON payload on stdin. */
async function fire(
  root: string,
  script: string,
  payload: Record<string, unknown>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [join(root, ".agents", "hooks", script)],
      { cwd: root },
      (error) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve(typeof error?.code === "number" ? error.code : 0);
      },
    );
    child.stdin?.end(JSON.stringify(payload));
  });
}

async function journal(root: string): Promise<JournalLine[]> {
  const dir = join(root, ...USAGE_JOURNAL_DIR.split("/"));
  const files = await readdir(dir).catch(() => []);
  const lines: JournalLine[] = [];
  for (const file of files.sort()) {
    const raw = await readFile(join(dir, file), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() !== "") lines.push(JSON.parse(line) as JournalLine);
    }
  }
  return lines;
}

async function rawJournal(root: string): Promise<string> {
  const dir = join(root, ...USAGE_JOURNAL_DIR.split("/"));
  const files = await readdir(dir).catch(() => []);
  let all = "";
  for (const file of files) {
    all += await readFile(join(dir, file), "utf8");
  }
  return all;
}

/** Adds or replaces the `[usage]` section of the manifest. */
async function setUsageSection(root: string, body: string): Promise<void> {
  const path = join(root, ".agents.toml");
  const source = await readFile(path, "utf8");
  await writeFile(
    path,
    source.replace("[projections]", `[usage]\n${body}\n\n[projections]`),
    "utf8",
  );
}

describe("25 - pack usage, the collection stage", () => {
  it("Given an initialized repo, When pack add usage runs, Then the collectors are installed and registered on all three harnesses, and check is green", async () => {
    const dir = await repoWithUsage();
    for (const file of HOOK_FILES) {
      expect(
        await pathExists(join(dir, ".agents", "hooks", file)),
        `${file} missing`,
      ).toBe(true);
    }
    expect(
      await pathExists(join(dir, ".agents", "hooks", "lib", "usage-log.mjs")),
    ).toBe(true);
    // registered by the install itself, not left for the next sync
    for (const [registry, needle] of [
      [".claude/settings.json", "pretooluse-usage.mjs"],
      [".codex/hooks.json", "pretooluse-usage.mjs"],
      [".cursor/hooks.json", "pretooluse-usage.mjs"],
    ] as const) {
      const source = await readFile(join(dir, ...registry.split("/")), "utf8");
      expect(source, `${registry} does not register the collector`).toContain(
        needle,
      );
    }
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
    expect(check.exitCode).toBe(0);
  });

  it("Given registries that did not exist, When the install writes them, Then the report says created, not updated", async () => {
    const { changes } = await repoWithUsageReport();
    // a repo installed with `core` alone has no Codex or Cursor registry: the
    // install creates both, and reporting that as an update would describe a
    // file the user never had as one the run modified
    for (const path of [".codex/hooks.json", ".cursor/hooks.json"]) {
      const change = changes.find((entry) => entry.path === path);
      expect(change, `${path} absent from the report`).toBeDefined();
      expect(change?.action, `${path} misreported`).toBe("created");
    }
  });

  it("Given a session touching files, invoking a skill and delegating, When the collectors run, Then skills, sub-agents, tools and repo-relative paths are journalled", async () => {
    const dir = await repoWithUsage();
    const session = "session-alpha";
    await fire(dir, "sessionstart-usage.mjs", {
      session_id: session,
      hook_event_name: "SessionStart",
    });
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: session,
      tool_name: "Read",
      tool_input: { file_path: "src/api/handler.ts" },
    });
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: session,
      tool_name: "Skill",
      tool_input: { skill: "verify" },
    });
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: session,
      tool_name: "Task",
      tool_input: { subagent_type: "reviewer" },
    });
    await fire(dir, "subagentstart-usage.mjs", {
      session_id: session,
      subagent_type: "reviewer",
    });
    await fire(dir, "sessionend-usage.mjs", {
      session_id: session,
      hook_event_name: "SessionEnd",
    });

    const lines = await journal(dir);
    expect(lines.map((line) => line.event)).toEqual([
      "SessionStart",
      "PreToolUse",
      "PreToolUse",
      "PreToolUse",
      "SubagentStart",
      "SessionEnd",
    ]);
    expect(lines.find((line) => line.tool === "Read")?.path).toBe(
      "src/api/handler.ts",
    );
    expect(lines.find((line) => line.skill !== null)?.skill).toBe("verify");
    expect(lines.filter((line) => line.agent === "reviewer")).toHaveLength(2);
    // one session, one key — and never the harness identifier itself
    const keys = new Set(lines.map((line) => line.session));
    expect(keys.size).toBe(1);
    expect(keys.has(session)).toBe(false);
  });

  it("Given payloads carrying a prompt, a command and file content, When the collectors run, Then none of that text reaches the journal", async () => {
    const dir = await repoWithUsage();
    const sentinel = "SENTINEL-b7f3-do-not-log";
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: "s",
      tool_name: "Bash",
      tool_input: { command: `psql -h prod -c '${sentinel}'` },
    });
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: "s",
      tool_name: "Write",
      tool_input: { file_path: "src/a.ts", content: sentinel },
    });
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: "s",
      tool_name: "Edit",
      tool_input: { file_path: "src/a.ts", old_string: sentinel },
    });
    const raw = await rawJournal(dir);
    expect(raw).not.toContain(sentinel);
    // the events are still counted: privacy is not achieved by dropping data
    expect((await journal(dir)).map((line) => line.tool)).toEqual([
      "Bash",
      "Write",
      "Edit",
    ]);
  });

  it("Given an absolute path or one escaping the repo, When it is journalled, Then it is recorded as null rather than naming the machine", async () => {
    const dir = await repoWithUsage();
    for (const file_path of [
      "/etc/passwd",
      "C:\\\\Users\\\\alice\\\\secrets.txt",
      "../sibling-repo/file.ts",
    ]) {
      await fire(dir, "pretooluse-usage.mjs", {
        session_id: "s",
        tool_name: "Read",
        tool_input: { file_path },
      });
    }
    const lines = await journal(dir);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.path === null)).toBe(true);
    const raw = await rawJournal(dir);
    expect(raw).not.toContain("passwd");
    expect(raw).not.toContain("sibling-repo");
  });

  it("Given exclude globs in the manifest, When a matching path is touched, Then the event is kept and the path is not", async () => {
    const dir = await repoWithUsage();
    await setUsageSection(dir, 'enabled = true\nexclude = ["src/clients/**"]');
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: "s",
      tool_name: "Read",
      tool_input: { file_path: "src/clients/acme/contract.ts" },
    });
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: "s",
      tool_name: "Read",
      tool_input: { file_path: "src/api/public.ts" },
    });
    const lines = await journal(dir);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.path).toBeNull();
    expect(lines[1]?.path).toBe("src/api/public.ts");
    expect(await rawJournal(dir)).not.toContain("acme");
    // the manifest reader accepted the section
    expect((await readManifest(dir)).usage).toEqual({
      enabled: true,
      exclude: ["src/clients/**"],
    });
  });

  it("Given enabled = false in the manifest, When the collectors run, Then nothing is written and the pack stays installed", async () => {
    const dir = await repoWithUsage();
    await setUsageSection(dir, "enabled = false");
    const code = await fire(dir, "pretooluse-usage.mjs", {
      session_id: "s",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
    });
    expect(code).toBe(0);
    expect(await journal(dir)).toEqual([]);
    // suspended, not uninstalled: the scripts and registrations stay
    expect(
      await pathExists(join(dir, ".agents", "hooks", "pretooluse-usage.mjs")),
    ).toBe(true);
    expect((await readManifest(dir)).packs.installed).toContain("usage");
  });

  it("Given the probe payload of check, When a collector receives it, Then the journal stays untouched", async () => {
    const dir = await repoWithUsage();
    // `check` invokes every hook script for real; a collector that wrote there
    // would make a read-only command touch the disk, in CI included
    await runCheck(dir);
    expect(await journal(dir)).toEqual([]);
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: HOOK_PROBE_SESSION_ID,
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
    });
    expect(await journal(dir)).toEqual([]);
  });

  it("Given a journal file older than the retention window, When a session boundary fires, Then it is pruned and the recent one is kept", async () => {
    const dir = await repoWithUsage();
    const journalDir = join(dir, ...USAGE_JOURNAL_DIR.split("/"));
    await mkdir(journalDir, { recursive: true });
    const stale = "usage-2020-01-01.jsonl";
    const today = `usage-${new Date().toISOString().slice(0, 10)}.jsonl`;
    await writeFile(join(journalDir, stale), "{}\n", "utf8");
    await writeFile(join(journalDir, today), "", "utf8");

    await fire(dir, "sessionend-usage.mjs", {
      session_id: "s",
      hook_event_name: "SessionEnd",
    });
    const files = await readdir(journalDir);
    expect(files).not.toContain(stale);
    expect(files).toContain(today);
  });

  it("Given a session that was observed, When git status is read, Then the journal is ignored and the working tree stays clean", async () => {
    const dir = await repoWithUsage();
    await execFileAsync("git", ["-C", dir, "add", "-A"]);
    await execFileAsync("git", [
      "-C",
      dir,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "install",
    ]);
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: "s",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
    });
    const { stdout } = await execFileAsync("git", [
      "-C",
      dir,
      "status",
      "--short",
    ]);
    expect(stdout.trim()).toBe("");
  });

  it("Given the journal added to the git index anyway, When check runs, Then it fails and names the removal command", async () => {
    const dir = await repoWithUsage();
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: "s",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
    });
    // the convention says no; `git add -f` says yes. The invariant must too.
    await execFileAsync("git", [
      "-C",
      dir,
      "add",
      "-f",
      "--",
      USAGE_JOURNAL_DIR,
    ]);
    const failed = await runCheck(dir);
    expect(failed.exitCode).toBe(1);
    const violation = failed.violations.find(
      (entry) => entry.rule === "usage-journal-tracked",
    );
    expect(violation?.severity).toBe("error");
    expect(violation?.message).toContain("git rm -r --cached");

    await execFileAsync("git", [
      "-C",
      dir,
      "rm",
      "-r",
      "--cached",
      "-q",
      "--",
      USAGE_JOURNAL_DIR,
    ]);
    expect((await runCheck(dir)).violations).toEqual([]);
  });

  it("Given a repo without the usage pack, When check runs, Then the journal invariant stays silent", async () => {
    const dir = await makeTempDir("pack-usage-absent");
    await execFileAsync("git", ["-C", dir, "init"]);
    await runInit(dir, initAnswers({ packs: ["core"] }), { dryRun: false });
    const check = await runCheck(dir);
    expect(
      check.violations.some((entry) => entry.rule === "usage-journal-tracked"),
    ).toBe(false);
  });

  it("Given an observed repo, When pack remove usage runs, Then scripts, registrations, rule and journal are all gone", async () => {
    const dir = await repoWithUsage();
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: "s",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
    });
    expect(await journal(dir)).toHaveLength(1);

    await runPackRemove(dir, "usage", { force: false, dryRun: false });

    for (const file of HOOK_FILES) {
      expect(
        await pathExists(join(dir, ".agents", "hooks", file)),
        `${file} left behind`,
      ).toBe(false);
    }
    expect(
      await pathExists(join(dir, ...USAGE_JOURNAL_DIR.split("/"))),
      "journal left behind",
    ).toBe(false);
    expect(
      await pathExists(join(dir, ".agents", "rules", "usage-journal.md")),
    ).toBe(false);
    for (const registry of [
      ".claude/settings.json",
      ".codex/hooks.json",
      ".cursor/hooks.json",
    ]) {
      const source = await readFile(join(dir, ...registry.split("/")), "utf8");
      expect(source, `${registry} still registers a collector`).not.toContain(
        "usage.mjs",
      );
    }
    expect((await readManifest(dir)).packs.installed).not.toContain("usage");
    expect((await runCheck(dir)).violations).toEqual([]);
  });

  it("Given the collectors, When the Bash allowlist is built, Then they are absent — the harness runs them, not the agent", async () => {
    const dir = await repoWithUsage();
    const settings = JSON.parse(
      await readFile(join(dir, ".claude", "settings.json"), "utf8"),
    ) as { permissions?: { allow?: string[] } };
    for (const entry of settings.permissions?.allow ?? []) {
      expect(
        entry,
        "a collector was announced as a runnable command",
      ).not.toContain(".agents/hooks/");
    }
  });

  it("Given a hook the user created, When the usage pack is added then removed, Then their hook survives and stays registered", async () => {
    const dir = await repoWithUsage();
    const event = resolveHookEvent("PreToolUse");
    if (event === undefined) {
      throw new Error("PreToolUse missing from the matrix");
    }
    await runAddHook(
      dir,
      { event, slug: "mine", matcher: undefined },
      {
        dryRun: false,
      },
    );
    const theirs = join(dir, ".agents", "hooks", "pretooluse-mine.mjs");
    const before = await readFile(theirs, "utf8");

    await runPackRemove(dir, "usage", { force: false, dryRun: false });

    // removing a pack must not take the neighbour's hook with the folder
    expect(await readFile(theirs, "utf8")).toBe(before);
    for (const registry of [
      ".claude/settings.json",
      ".codex/hooks.json",
      ".cursor/hooks.json",
    ]) {
      const source = await readFile(join(dir, ...registry.split("/")), "utf8");
      expect(source, `${registry} deregistered the user's hook`).toContain(
        "pretooluse-mine.mjs",
      );
      expect(source).not.toContain("usage.mjs");
    }
    expect((await runCheck(dir)).violations).toEqual([]);
  });

  it("Given a pack that ships no hook, When it is added to a repo that already has one, Then no registry is touched", async () => {
    const dir = await makeTempDir("pack-usage-nohooks");
    await execFileAsync("git", ["-C", dir, "init"]);
    await runInit(dir, initAnswers({ packs: ["core"] }), { dryRun: false });
    const event = resolveHookEvent("PreToolUse");
    if (event === undefined) {
      throw new Error("PreToolUse missing from the matrix");
    }
    await runAddHook(
      dir,
      { event, slug: "mine", matcher: undefined },
      {
        dryRun: false,
      },
    );
    // creator ships meta-skills and no hook: the registration pass added for
    // `usage` must stay silent here rather than rewriting three files
    const plan = await runPackAdd(dir, "creator", { dryRun: true });
    // a change entry exists only for a file the run would write, so the
    // registries must simply be absent from the plan
    const registries = plan.changes.filter((change) =>
      [".codex/hooks.json", ".cursor/hooks.json"].includes(change.path),
    );
    expect(registries).toEqual([]);
    // .claude/settings.json may still appear for the Bash allowlist of the
    // pack's scripts — but never carrying a hook registration
    const settings = plan.changes.find(
      (change) => change.path === ".claude/settings.json",
    );
    if (settings !== undefined) {
      expect(settings.action).not.toBe("removed");
    }
  });

  it("Given an unreadable or empty payload, When a collector runs, Then it exits 0 and never blocks the session", async () => {
    const dir = await repoWithUsage();
    // fail-open is the whole contract: observation must not be able to stop an
    // agent, whatever the harness sends
    expect(await fire(dir, "pretooluse-usage.mjs", {})).toBe(0);
    expect(
      await fire(dir, "pretooluse-usage.mjs", {
        session_id: "s",
        tool_input: "not-an-object",
      }),
    ).toBe(0);
    expect(await fire(dir, "sessionstart-usage.mjs", {})).toBe(0);
  });
});
