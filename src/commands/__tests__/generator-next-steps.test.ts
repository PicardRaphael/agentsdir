import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HARNESS_SPECS, HARNESSES } from "../../core/harnesses.js";
import { initAnswers, makeTempDir, runCli } from "../../test-support/index.js";
import {
  CHECK_STEP,
  invocationStep,
  renderGeneratorReport,
  type GeneratorResult,
} from "../add-common.js";
import { agentNextSteps } from "../add-agent.js";
import { hookNextSteps } from "../add-hook.js";
import { ruleNextSteps } from "../add-rule.js";
import { skillNextSteps } from "../add-skill.js";
import { runInit } from "../init.js";

const execFileAsync = promisify(execFile);

/** A repo the CLI can be run in as a subprocess: git first, then the install. */
async function gitRepo(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

function report(
  steps: Parameters<typeof renderGeneratorReport>[1]["nextSteps"],
  dryRun = false,
): string {
  const result: GeneratorResult = {
    changes: [{ path: ".agents/skills/demo/SKILL.md", action: "created" }],
    exitCode: 0,
    mode: "copy",
  };
  return renderGeneratorReport(result, { dryRun, nextSteps: steps });
}

/**
 * Criterion: "each generator ends on a named next step: what is left to write
 * in the file it created, and the command that verifies it."
 */
describe("Given a generator that just created a skeleton", () => {
  it("When `add skill` reports, Then it names the sections to fill and the command that verifies", () => {
    const steps = skillNextSteps("demo-flow", ["claude"]);
    const rendered = report(steps);
    expect(rendered).toContain("Next steps:");
    // the PATH, not "the body": .claude/ holds a copy of the same file, and a
    // reader told only to edit "the body" can lose the work to the next sync
    expect(steps[0]?.action).toBe("write .agents/skills/demo-flow/SKILL.md");
    expect(rendered).toContain("Objective, Procedure, Verification");
    expect(rendered).toContain("the .claude/ copy of this skill is generated");
    // "everything under .claude/" would have covered .claude/settings.json,
    // which add hook declares to be the user's: the two must not contradict
    expect(rendered).not.toContain("everything under .claude/");
    expect(rendered).toContain(CHECK_STEP.action);
  });

  it("When `add rule` reports, Then the first step is the line the rules index is built from", () => {
    const steps = ruleNextSteps("demo-rule");
    const rendered = report(steps);
    expect(steps[0]?.action).toContain(".agents/rules/demo-rule.md");
    expect(steps[0]?.action).toContain("first line");
    expect(rendered).toContain("AGENTS.md already points here");
    expect(rendered).toContain(CHECK_STEP.action);
  });

  it("When `add agent` reports, Then it names the field that decides delegation and the body's role", () => {
    const rendered = report(agentNextSteps("demo-agent"));
    expect(rendered).toContain(".agents/agents/demo-agent.md");
    expect(rendered).toContain("description");
    expect(rendered).toContain("delegated to");
    expect(rendered).toContain("system prompt");
    expect(rendered).toContain(CHECK_STEP.action);
  });

  it("When `add hook` reports, Then it says the body decides nothing yet and the registries are shared", () => {
    const rendered = report(hookNextSteps(".agents/hooks/pretooluse-hook.mjs"));
    expect(rendered).toContain("TODO in .agents/hooks/pretooluse-hook.mjs");
    expect(rendered).toContain("blocks nothing until you do");
    // "holds it to the protocol" pointed at a contract it never named
    expect(rendered).toContain("stdin, stdout and exit-code contract");
    // the hook follows another model: registries, not copies
    expect(rendered).toContain("they are not copies of it");
    expect(rendered).toContain("left anything else in them untouched");
    expect(rendered).toContain("npx agentsdir check");
  });

  it("When nothing was written, Then a dry run states no step: there is no file to fill in", () => {
    const rendered = report(skillNextSteps("demo-flow", ["claude"]), true);
    expect(rendered).toContain("Dry run — nothing was written.");
    expect(rendered).not.toContain("Next steps:");
  });

  it("When a command passes no step, Then its report is exactly what it was", () => {
    // `pack add` and `pack remove` share this renderer and are out of scope
    expect(report(undefined)).toBe(
      "Done:\n  created  .agents/skills/demo/SKILL.md",
    );
  });
});

/**
 * Criterion: "`add skill` names the way to invoke the created skill in a
 * harness" — and the standing rule that no module decides by naming one.
 */
describe("Given the harnesses a repository enabled", () => {
  it("When a skill is created, Then the invocation shown is the one those harnesses use", () => {
    expect(invocationStep("demo-flow", ["claude"])?.action).toBe("/demo-flow");
    expect(invocationStep("demo-flow", ["codex"])?.action).toBe("$demo-flow");
    expect(invocationStep("demo-flow", ["claude", "codex"])?.action).toBe(
      "/demo-flow · $demo-flow",
    );
  });

  it("When a harness declares no verified invocation, Then none is invented for it", () => {
    expect(HARNESS_SPECS.cursor.invocation).toBeUndefined();
    expect(invocationStep("demo-flow", ["cursor"])).toBeUndefined();
    // and a repository on Cursor alone gets the rest of the block, not a lie
    expect(skillNextSteps("demo-flow", ["cursor"])).toHaveLength(2);
  });

  it("When every harness is enabled, Then only those with a declared syntax appear", () => {
    const step = invocationStep("demo-flow", [...HARNESSES]);
    expect(step?.why).toContain("claude, codex");
    expect(step?.why).not.toContain("cursor");
  });
});

describe("Given a repository where a hook already registered", () => {
  it("When a second hook is added, Then each registry is reported as updated, not created", async () => {
    const dir = await gitRepo("hook-registry-actions");
    const first = await runCli(dir, ["add", "hook", "PreToolUse", "--json"]);
    const second = await runCli(dir, [
      "add",
      "hook",
      "PostToolUse",
      "--json",
      "--name",
      "second",
    ]);
    const actions = (raw: string) =>
      new Map(
        (
          JSON.parse(raw) as {
            changes: { path: string; action: string }[];
          }
        ).changes.map((change) => [change.path, change.action]),
      );
    for (const harness of HARNESSES) {
      const registry = HARNESS_SPECS[harness].hookRegistry;
      expect(actions(first.stdout).get(registry ?? ""), registry).toBe(
        "created",
      );
      expect(actions(second.stdout).get(registry ?? ""), registry).toBe(
        "updated",
      );
    }
  });

  it("When --json is used, Then the machine output carries no next step", async () => {
    const dir = await gitRepo("generator-json-steps");
    const run = await runCli(dir, ["add", "skill", "demo-flow", "--json"]);
    expect(run.stdout).not.toContain("Next steps");
    expect(Object.keys(JSON.parse(run.stdout)).sort()).toEqual([
      "changes",
      "command",
      "errors",
      "exitCode",
      "mode",
    ]);
  });
});
