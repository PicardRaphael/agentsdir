import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../../core/frontmatter.js";
import { EXIT_CODES } from "../../exit-codes.js";
import {
  defaultAgentAnswers,
  type AgentAnswers,
} from "../../templates/agent.js";
import { defaultSkillAnswers } from "../../templates/skill.js";
import { initAnswers, makeTempDir, runCli } from "../../test-support/index.js";
import { DEFAULT_RULE_HOOK } from "../add-rule.js";
import { runInit } from "../init.js";

const execFileAsync = promisify(execFile);

/**
 * "Every interview question has a flag" (`docs/commandes.md`). Without a TTY —
 * the agent path the README puts forward — a flag is the only way to give a
 * real answer rather than a guessed one, so a question without one is a field
 * no script can ever fill.
 */
const SKILL_FLAGS = [
  "--description",
  "--display-name",
  "--short-description",
  "--color",
  "--icon",
  "--default-prompt",
];

async function initializedRepo(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

describe("35 - every generator question has a flag", () => {
  it("Given `add skill --help`, When it runs, Then every question of its interview is listed as a flag", async () => {
    const dir = await initializedRepo("generator-flags-help-skill");

    const { stdout } = await runCli(dir, ["add", "skill", "--help"]);

    for (const flag of SKILL_FLAGS) {
      expect(stdout, flag).toContain(flag);
    }
  });

  it("Given `add rule --help` and `add agent --help`, When they run, Then their question is listed as a flag", async () => {
    const dir = await initializedRepo("generator-flags-help-others");

    const rule = await runCli(dir, ["add", "rule", "--help"]);
    const agent = await runCli(dir, ["add", "agent", "--help"]);

    expect(rule.stdout).toContain("--hook");
    expect(agent.stdout).toContain("--description");
  });

  it("Given `add skill` with every flag and no TTY, When it runs, Then no template default survives in the written skill", async () => {
    const dir = await initializedRepo("generator-flags-skill");
    const defaults = defaultSkillAnswers("flagged-skill", false);
    const answers = {
      description: "Use when the release notes need rebuilding from the log.",
      displayName: "Release Notes",
      shortDescription: "Rebuilds the release notes from the log",
      color: "#A31F34",
      icon: "book-open",
      defaultPrompt: "Use $flagged-skill to rebuild the release notes.",
    };

    const { code } = await runCli(dir, [
      "add",
      "skill",
      "flagged-skill",
      "--description",
      answers.description,
      "--display-name",
      answers.displayName,
      "--short-description",
      answers.shortDescription,
      "--color",
      answers.color,
      "--icon",
      answers.icon,
      "--default-prompt",
      answers.defaultPrompt,
    ]);

    expect(code).toBe(EXIT_CODES.ok);
    const source = await readFile(
      join(dir, ".agents", "skills", "flagged-skill", "SKILL.md"),
      "utf8",
    );
    const { frontmatter } = parseSkillMarkdown(source);
    expect(frontmatter.description).toBe(answers.description);
    expect(frontmatter.displayName).toBe(answers.displayName);
    expect(frontmatter.shortDescription).toBe(answers.shortDescription);
    expect(frontmatter.color).toBe(answers.color);
    expect(frontmatter.icon).toBe(answers.icon);
    expect(frontmatter.defaultPrompt).toBe(answers.defaultPrompt);
    // the point of the flags: not one field fell back on the template
    expect(frontmatter.description).not.toBe(defaults.description);
    expect(frontmatter.color).not.toBe(defaults.color);
    expect(frontmatter.icon).not.toBe(defaults.icon);
  });

  it("Given `add rule --hook` and `add agent --description` with no TTY, When they run, Then the file carries the given answer, not the default", async () => {
    const dir = await initializedRepo("generator-flags-others");
    const hook = "Read before touching the billing endpoints of src/api/**.";
    const description = "Delegate the release audit to this agent.";

    const rule = await runCli(dir, [
      "add",
      "rule",
      "billing",
      "--hook",
      hook,
      "--paths",
      "src/api/**",
    ]);
    const agent = await runCli(dir, [
      "add",
      "agent",
      "auditor",
      "--description",
      description,
    ]);

    expect(rule.code).toBe(EXIT_CODES.ok);
    expect(agent.code).toBe(EXIT_CODES.ok);
    const ruleSource = await readFile(
      join(dir, ".agents", "rules", "billing.md"),
      "utf8",
    );
    expect(ruleSource).toContain(hook);
    expect(ruleSource).not.toContain(DEFAULT_RULE_HOOK);
    const agentSource = await readFile(
      join(dir, ".agents", "agents", "auditor.md"),
      "utf8",
    );
    const defaults: AgentAnswers = defaultAgentAnswers("auditor", "inherit");
    expect(agentSource).toContain(description);
    expect(agentSource).not.toContain(defaults.description);
  });

  it("Given a flag carrying what its prompt would refuse, When the generator runs, Then it is a usage error naming the flag", async () => {
    const dir = await initializedRepo("generator-flags-invalid");

    const color = await runCli(dir, [
      "add",
      "skill",
      "bad-color",
      "--color",
      "crimson",
    ]);
    const icon = await runCli(dir, [
      "add",
      "skill",
      "bad-icon",
      "--icon",
      "not-an-icon",
    ]);
    const short = await runCli(dir, [
      "add",
      "skill",
      "bad-short",
      "--short-description",
      "too short",
    ]);
    const prompt = await runCli(dir, [
      "add",
      "skill",
      "bad-prompt",
      "--default-prompt",
      "no token here",
    ]);

    expect(color.code).toBe(EXIT_CODES.environmentOrUsage);
    expect(color.stderr).toContain("--color");
    expect(icon.code).toBe(EXIT_CODES.environmentOrUsage);
    expect(icon.stderr).toContain("--icon");
    expect(short.code).toBe(EXIT_CODES.environmentOrUsage);
    expect(short.stderr).toContain("--short-description");
    expect(prompt.code).toBe(EXIT_CODES.environmentOrUsage);
    expect(prompt.stderr).toContain("--default-prompt");
  });
});
