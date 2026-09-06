import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../exit-codes.js";
import { makeTempDir, runCli } from "../../test-support/index.js";

const execFileAsync = promisify(execFile);

/**
 * `init` is the command an agent runs first, and it was the only one whose
 * result it could not read: `--json` was swallowed, the output stayed the human
 * report, and `init --help` never listed the flag — while
 * `docs/commandes.md` promises the object for every command.
 */
interface JsonReport {
  command: string;
  mode: string | null;
  changes: { path: string; action: string }[];
  errors: unknown[];
  exitCode: number;
}

async function gitRepo(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await execFileAsync("git", ["-C", dir, "init"]);
  return dir;
}

describe("35 - init --json", () => {
  it("Given a fresh repo, When `init --json` runs, Then stdout carries one object in the shared format", async () => {
    const dir = await gitRepo("init-json-fresh");

    const { stdout, code } = await runCli(dir, ["init", "--json"]);

    expect(code).toBe(EXIT_CODES.ok);
    // a script parses stdout whole: one line, one object, no human sentence
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    const report = JSON.parse(stdout) as JsonReport;
    expect(Object.keys(report).sort()).toEqual([
      "changes",
      "command",
      "errors",
      "exitCode",
      "mode",
    ]);
    expect(report.command).toBe("init");
    expect(report.mode).toMatch(/^(symlink|copy)$/);
    expect(report.errors).toEqual([]);
    expect(report.exitCode).toBe(EXIT_CODES.ok);
    expect(report.changes.length).toBeGreaterThan(0);
    expect(report.changes.map((change) => change.path)).toContain(
      ".agents.toml",
    );
    // the shared vocabulary, and never the planned bytes: `content` on stdout
    // would dump the whole installation into the pipe
    for (const change of report.changes) {
      expect(["created", "updated", "ok"]).toContain(change.action);
      expect(Object.keys(change).sort()).toEqual(["action", "path"]);
    }
  });

  it("Given an already initialized repo, When `init --json` runs, Then stdout is still one object, with no change and exit 0", async () => {
    const dir = await gitRepo("init-json-again");
    await runCli(dir, ["init", "--yes"]);

    const { stdout, code } = await runCli(dir, ["init", "--json"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    const report = JSON.parse(stdout) as JsonReport;
    expect(report.command).toBe("init");
    expect(report.changes).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.exitCode).toBe(EXIT_CODES.ok);
  });

  it("Given `--dry-run --json`, When init runs, Then the object reports the plan and the disk stays untouched", async () => {
    const dir = await gitRepo("init-json-dry");

    const { stdout, code } = await runCli(dir, [
      "init",
      "--json",
      "--dry-run",
      "--yes",
    ]);

    expect(code).toBe(EXIT_CODES.ok);
    const report = JSON.parse(stdout) as JsonReport;
    expect(report.changes.length).toBeGreaterThan(0);
    const after = await runCli(dir, ["init", "--json"]);
    // still a fresh repo: the dry run wrote nothing
    expect(
      (JSON.parse(after.stdout) as JsonReport).changes.length,
    ).toBeGreaterThan(0);
  });

  it("Given `init --help`, When it runs, Then --json is listed", async () => {
    const dir = await gitRepo("init-json-help");

    const { stdout } = await runCli(dir, ["init", "--help"]);

    expect(stdout).toContain("--json");
  });
});
