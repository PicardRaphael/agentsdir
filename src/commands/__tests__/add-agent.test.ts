import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CliError } from "../../core/errors.js";
import { defaultAgentAnswers } from "../../templates/agent.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
  runCli,
} from "../../test-support/index.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runAddAgent } from "../add-agent.js";

const execFileAsync = promisify(execFile);

async function initializedRepo(): Promise<string> {
  const dir = await makeTempDir("add-agent");
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

describe("09 - add agent", () => {
  it("Given a valid name, When add agent runs, Then the file carries name, description, color and model plus the system prompt template", async () => {
    const dir = await initializedRepo();
    const result = await runAddAgent(
      dir,
      defaultAgentAnswers("code-reviewer", "inherit"),
      { dryRun: false },
    );
    expect(result.exitCode).toBe(0);
    expect(result.changes).toEqual([
      { path: ".agents/agents/code-reviewer.md", action: "created" },
      // the generator projects to the harnesses too
      { path: ".claude/agents/code-reviewer.md", action: "created" },
    ]);
    const source = await readFile(
      join(dir, ".agents", "agents", "code-reviewer.md"),
      "utf8",
    );
    expect(source).toContain("name: code-reviewer");
    expect(source).toContain("description: ");
    expect(source).toContain("color: blue");
    expect(source).toContain("model: inherit");
    expect(source).toContain("## Mission");
    const check = await runCheck(dir);
    expect(check.exitCode).toBe(0);
  });

  it("Given --model, When add agent runs, Then the frontmatter model is the given one", async () => {
    const dir = await initializedRepo();
    await runAddAgent(dir, defaultAgentAnswers("code-reviewer", "sonnet"), {
      dryRun: false,
    });
    const source = await readFile(
      join(dir, ".agents", "agents", "code-reviewer.md"),
      "utf8",
    );
    expect(source).toContain("model: sonnet");
  });

  it("Given an agent name already taken, When add agent runs, Then it exits 2 and writes nothing", async () => {
    const dir = await initializedRepo();
    await runAddAgent(dir, defaultAgentAnswers("code-reviewer", "inherit"), {
      dryRun: false,
    });
    const before = await readFile(
      join(dir, ".agents", "agents", "code-reviewer.md"),
      "utf8",
    );
    let error: unknown;
    try {
      await runAddAgent(dir, defaultAgentAnswers("code-reviewer", "opus"), {
        dryRun: false,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    expect(
      await readFile(
        join(dir, ".agents", "agents", "code-reviewer.md"),
        "utf8",
      ),
    ).toBe(before);
  });

  it("Given --dry-run, When add agent runs, Then nothing is written and the exit code equals the real run", async () => {
    const dir = await initializedRepo();
    const answers = defaultAgentAnswers("code-reviewer", "inherit");
    const dry = await runAddAgent(dir, answers, { dryRun: true });
    expect(dry.exitCode).toBe(0);
    expect(
      await pathExists(join(dir, ".agents", "agents", "code-reviewer.md")),
    ).toBe(false);
    const real = await runAddAgent(dir, answers, { dryRun: false });
    expect(real.exitCode).toBe(dry.exitCode);
    expect(real.changes).toEqual(dry.changes);
  });

  it("Given a non-TTY terminal, When the CLI runs add agent --json, Then defaults apply and the agent is created", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    const { code, stdout } = await runCli(dir, [
      "add",
      "agent",
      "code-reviewer",
      "--model",
      "sonnet",
      "--json",
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as { command: string; exitCode: number };
    expect(report.command).toBe("add agent");
    expect(report.exitCode).toBe(0);
    const source = await readFile(
      join(dir, ".agents", "agents", "code-reviewer.md"),
      "utf8",
    );
    expect(source).toContain("model: sonnet");
  });
});
