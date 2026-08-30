import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../core/errors.js";
import { extractBlock } from "../../core/managed-blocks.js";
import { runCheck } from "../check.js";
import { runInit, type InitAnswers } from "../init.js";
import { runSync } from "../sync.js";
import { parsePathsFlag, runAddRule } from "../add-rule.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentsdir-add-rule-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  tempDirs = [];
});

function initAnswers(): InitAnswers {
  return {
    productName: "demo",
    description: "A demo product.",
    commands: { test: "npm test" },
    harnesses: ["claude", "codex", "cursor"],
    packs: ["core"],
    mode: "copy",
    stacks: [],
  };
}

async function initializedRepo(): Promise<string> {
  const dir = await makeTempDir();
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

function runCli(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          stdout,
          stderr,
          code: typeof error?.code === "number" ? error.code : 0,
        });
      },
    );
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("09 - add rule", () => {
  it("Given a valid name, When add rule runs, Then the rule file matches the template: H1, imperative tone and GOOD/BAD sections", async () => {
    const dir = await initializedRepo();
    const result = await runAddRule(
      dir,
      {
        name: "api-conventions",
        hook: "Read before editing API handlers.",
        paths: [],
      },
      { dryRun: false },
    );
    expect(result.exitCode).toBe(0);
    const source = await readFile(
      join(dir, ".agents", "rules", "api-conventions.md"),
      "utf8",
    );
    expect(source.startsWith("# Api Conventions\n")).toBe(true);
    expect(source).toContain("Read before editing API handlers.");
    expect(source).toContain("ALWAYS");
    expect(source).toContain("NEVER");
    expect(source).toContain("GOOD:");
    expect(source).toContain("BAD:");
    expect(source).toContain("| Case | Do |");
  });

  it("Given --paths globs, When add rule runs, Then the rule carries the scope frontmatter with each glob", async () => {
    const dir = await initializedRepo();
    await runAddRule(
      dir,
      {
        name: "api-conventions",
        hook: "Read before editing API handlers.",
        paths: ["src/api/**", "docs/**"],
      },
      { dryRun: false },
    );
    const source = await readFile(
      join(dir, ".agents", "rules", "api-conventions.md"),
      "utf8",
    );
    expect(source.startsWith("---\npaths:\n")).toBe(true);
    expect(source).toContain('  - "src/api/**"');
    expect(source).toContain('  - "docs/**"');
  });

  it("Given the when-to-read sentence, When add rule updates AGENTS.md, Then the managed rules-index block gains the path — when-to-read line", async () => {
    const dir = await initializedRepo();
    await runAddRule(
      dir,
      {
        name: "api-conventions",
        hook: "Read before editing API handlers.",
        paths: [],
      },
      { dryRun: false },
    );
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    const block = extractBlock(agentsMd, "rules-index", "html");
    expect(block).toContain(
      "- `.agents/rules/api-conventions.md` — before editing API handlers.",
    );
    // entries installed by init are still indexed
    expect(block).toContain(".agents/rules/tasks.md");
    expect(block).toContain(".agents/rules/memory.md");
  });

  it("Given a rule name already taken, When add rule runs, Then it exits 2 and neither the rule nor AGENTS.md is written", async () => {
    const dir = await initializedRepo();
    const ruleBefore = await readFile(
      join(dir, ".agents", "rules", "tasks.md"),
      "utf8",
    );
    const agentsMdBefore = await readFile(join(dir, "AGENTS.md"), "utf8");
    let error: unknown;
    try {
      await runAddRule(
        dir,
        { name: "tasks", hook: "Read whenever.", paths: [] },
        { dryRun: false },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    expect(
      await readFile(join(dir, ".agents", "rules", "tasks.md"), "utf8"),
    ).toBe(ruleBefore);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(agentsMdBefore);
  });

  it("Given --dry-run, When add rule runs, Then the plan is reported, nothing is written and the exit code equals the real run", async () => {
    const dir = await initializedRepo();
    const agentsMdBefore = await readFile(join(dir, "AGENTS.md"), "utf8");
    const answers = {
      name: "api-conventions",
      hook: "Read before editing API handlers.",
      paths: [],
    };
    const dry = await runAddRule(dir, answers, { dryRun: true });
    expect(dry.exitCode).toBe(0);
    expect(dry.changes).toEqual([
      { path: ".agents/rules/api-conventions.md", action: "created" },
      { path: "AGENTS.md", action: "updated" },
      // the generator projects to the harnesses too
      { path: ".claude/rules/api-conventions.md", action: "created" },
    ]);
    expect(
      await pathExists(join(dir, ".agents", "rules", "api-conventions.md")),
    ).toBe(false);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(agentsMdBefore);
    const real = await runAddRule(dir, answers, { dryRun: false });
    expect(real.exitCode).toBe(dry.exitCode);
    expect(real.changes).toEqual(dry.changes);
  });

  it("Given add rule completed, When check runs right after, Then it exits 0", async () => {
    const dir = await initializedRepo();
    await runAddRule(
      dir,
      {
        name: "api-conventions",
        hook: "Read before editing API handlers.",
        paths: ["src/api/**"],
      },
      { dryRun: false },
    );
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
    expect(check.exitCode).toBe(0);
  });

  it("Given add rule completed, When sync runs right after, Then the index it wrote is exactly the one sync derives (AGENTS.md ok, never duplicated)", async () => {
    const dir = await initializedRepo();
    await runAddRule(
      dir,
      {
        name: "api-conventions",
        hook: "Read before editing API handlers.",
        paths: [],
      },
      { dryRun: false },
    );
    const sync = await runSync(dir, { dryRun: true });
    expect(sync.exitCode).toBe(0);
    const agentsMdChange = sync.changes.find(
      (change) => change.path === "AGENTS.md",
    );
    expect(agentsMdChange?.action).toBe("ok");
  });

  it("Given an empty --paths value, When parsed, Then it is a usage error and a missing flag means a global rule", () => {
    expect(parsePathsFlag(undefined)).toEqual([]);
    expect(parsePathsFlag("src/api/**, docs/**")).toEqual([
      "src/api/**",
      "docs/**",
    ]);
    let error: unknown;
    try {
      parsePathsFlag(" , ");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
  });

  it("Given a non-TTY terminal, When the CLI runs add rule --json, Then defaults apply and the rule is created and indexed", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    const { code, stdout } = await runCli(dir, [
      "add",
      "rule",
      "review-checklist",
      "--json",
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      command: string;
      changes: { path: string }[];
      exitCode: number;
    };
    expect(report.command).toBe("add rule");
    expect(report.exitCode).toBe(0);
    expect(
      await pathExists(join(dir, ".agents", "rules", "review-checklist.md")),
    ).toBe(true);
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain(".agents/rules/review-checklist.md");
  });
});
