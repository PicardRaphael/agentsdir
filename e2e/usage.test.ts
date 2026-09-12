import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { USAGE_JOURNAL_DIR } from "../src/core/usage-journal.js";
import { makeTempDir, runCli } from "../src/test-support/index.js";

const execFileAsync = promisify(execFile);

/**
 * The collection stage walked against the compiled CLI, on a demonstration
 * repo, with payloads shaped like each of the three harnesses send them —
 * Claude Code and Codex share the snake_case envelope, Cursor uses its own
 * tool vocabulary and lowerCamelCase keys.
 */

const SENTINEL = "SENTINEL-e2e-never-log-this";

/** One hook invocation, exactly as a harness performs it. */
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

async function readJournal(root: string): Promise<string> {
  const dir = join(root, ...USAGE_JOURNAL_DIR.split("/"));
  const files = await readdir(dir).catch(() => []);
  let all = "";
  for (const file of files.sort()) {
    all += await readFile(join(dir, file), "utf8");
  }
  return all;
}

describe("25 - usage collection end to end", () => {
  it("Given a demo repo, When the pack is installed and a session is simulated on three harness shapes, Then the journal holds metadata only and check stays green", async () => {
    const dir = await makeTempDir("e2e-usage");
    await execFileAsync("git", ["-C", dir, "init"]);
    await writeFile(
      join(dir, "package.json"),
      '{ "name": "demo", "private": true }\n',
      "utf8",
    );
    const init = await runCli(dir, [
      "init",
      "--yes",
      "--mode",
      "copy",
      "--packs",
      "core",
    ]);
    expect(init.code, init.stderr).toBe(0);
    const add = await runCli(dir, ["pack", "add", "usage"]);
    expect(add.code, add.stderr).toBe(0);

    // Claude Code / Codex envelope
    await fire(dir, "sessionstart-usage.mjs", {
      session_id: "claude-1",
      hook_event_name: "SessionStart",
      cwd: ".",
    });
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: "claude-1",
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/index.ts", old_string: SENTINEL },
    });
    await fire(dir, "pretooluse-usage.mjs", {
      session_id: "claude-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `echo ${SENTINEL}` },
    });
    // Cursor: its own tool vocabulary (Shell, not Bash) and camelCase keys
    await fire(dir, "pretooluse-usage.mjs", {
      sessionId: "cursor-1",
      toolName: "Shell",
      toolInput: { command: SENTINEL },
    });
    await fire(dir, "pretooluse-usage.mjs", {
      sessionId: "cursor-1",
      toolName: "Read",
      toolInput: { filePath: "src/index.ts" },
    });
    await fire(dir, "sessionend-usage.mjs", {
      session_id: "claude-1",
      hook_event_name: "SessionEnd",
    });

    const raw = await readJournal(dir);
    expect(raw, "a payload secret reached the journal").not.toContain(SENTINEL);
    const lines = raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(6);
    // both harness shapes were understood, and the two sessions stay distinct
    expect(lines.map((line) => line["tool"])).toEqual([
      null,
      "Edit",
      "Bash",
      "Shell",
      "Read",
      null,
    ]);
    expect(new Set(lines.map((line) => line["session"])).size).toBe(2);
    // exactly the contracted field set, nothing more
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual([
        "agent",
        "event",
        "path",
        "session",
        "skill",
        "tool",
        "ts",
      ]);
    }

    const check = await runCli(dir, ["check"]);
    expect(check.code, check.stdout).toBe(0);
    expect(check.stdout).toContain("Check passed");

    // observed, and the working tree is still clean
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
      session_id: "claude-2",
      tool_name: "Read",
      tool_input: { file_path: "src/index.ts" },
    });
    const status = await execFileAsync("git", ["-C", dir, "status", "--short"]);
    expect(status.stdout.trim()).toBe("");

    // and the uninstall takes everything with it
    const remove = await runCli(dir, ["pack", "remove", "usage"]);
    expect(remove.code, remove.stderr).toBe(0);
    expect(await readJournal(dir)).toBe("");
    const after = await runCli(dir, ["check"]);
    expect(after.code, after.stdout).toBe(0);
  }, 60000);
});
