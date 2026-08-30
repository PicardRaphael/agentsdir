import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  renderOpenAiYaml,
  renderSkillIcon,
} from "../../core/codex-metadata.js";
import { CliError } from "../../core/errors.js";
import { parseSkillMarkdown } from "../../core/frontmatter.js";
import { defaultSkillAnswers, renderSkillMd } from "../../templates/skill.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
  runCli,
} from "../../test-support/index.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { ensureImplicitIsReadOnly, runAddSkill } from "../add-skill.js";

const execFileAsync = promisify(execFile);

async function initializedRepo(): Promise<string> {
  const dir = await makeTempDir("add-skill");
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

describe("09 - add skill", () => {
  it("Given a valid name, When add skill runs, Then SKILL.md carries the complete extended frontmatter with disable-model-invocation true by default", async () => {
    const dir = await initializedRepo();
    const answers = defaultSkillAnswers("demo-skill", false);
    const result = await runAddSkill(dir, answers, { dryRun: false });
    expect(result.exitCode).toBe(0);
    const source = await readFile(
      join(dir, ".agents", "skills", "demo-skill", "SKILL.md"),
      "utf8",
    );
    const { frontmatter } = parseSkillMarkdown(source);
    expect(frontmatter.name).toBe("demo-skill");
    expect(frontmatter.description).toContain("Use when");
    expect(frontmatter.displayName).toBe("Demo Skill");
    expect(frontmatter.color).toBe("#1F4E8C");
    expect(frontmatter.icon).toBe("terminal");
    expect(frontmatter.defaultPrompt).toContain("$demo-skill");
    expect(frontmatter.disableModelInvocation).toBe(true);
    expect(frontmatter.implicit).toBe(false);
  });

  it("Given the generated SKILL.md, When its body is measured, Then the guided body has at least 12 significant lines", () => {
    const source = renderSkillMd(defaultSkillAnswers("demo-skill", false));
    const { body } = parseSkillMarkdown(source);
    const significant = body
      .split("\n")
      .filter((line) => line.trim() !== "").length;
    expect(significant).toBeGreaterThanOrEqual(12);
  });

  it("Given add skill completed, When the Codex artifacts are read, Then openai.yaml and icon.svg equal the deterministic render of the frontmatter", async () => {
    const dir = await initializedRepo();
    const answers = defaultSkillAnswers("demo-skill", false);
    await runAddSkill(dir, answers, { dryRun: false });
    const skillDir = join(dir, ".agents", "skills", "demo-skill");
    const { frontmatter } = parseSkillMarkdown(
      await readFile(join(skillDir, "SKILL.md"), "utf8"),
    );
    expect(
      await readFile(join(skillDir, "agents", "openai.yaml"), "utf8"),
    ).toBe(renderOpenAiYaml(frontmatter));
    expect(await readFile(join(skillDir, "assets", "icon.svg"), "utf8")).toBe(
      renderSkillIcon(frontmatter),
    );
  });

  it("Given add skill completed on a copy-mode repo, When check runs right after, Then it exits 0", async () => {
    const dir = await initializedRepo();
    await runAddSkill(dir, defaultSkillAnswers("demo-skill", false), {
      dryRun: false,
    });
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
    expect(check.exitCode).toBe(0);
  });

  it("Given --implicit without the explicit read-only declaration, When the gate runs, Then it refuses with exit 2", () => {
    let error: unknown;
    try {
      ensureImplicitIsReadOnly({ implicit: true, readOnly: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    expect(() =>
      ensureImplicitIsReadOnly({ implicit: true, readOnly: true }),
    ).not.toThrow();
    expect(() =>
      ensureImplicitIsReadOnly({ implicit: false, readOnly: false }),
    ).not.toThrow();
  });

  it("Given the read-only declaration, When add skill runs with implicit, Then the skill allows implicit invocation without write tools and check passes", async () => {
    const dir = await initializedRepo();
    await runAddSkill(dir, defaultSkillAnswers("read-me", true), {
      dryRun: false,
    });
    const { frontmatter } = parseSkillMarkdown(
      await readFile(
        join(dir, ".agents", "skills", "read-me", "SKILL.md"),
        "utf8",
      ),
    );
    expect(frontmatter.implicit).toBe(true);
    expect(frontmatter.disableModelInvocation).toBeUndefined();
    expect(frontmatter.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    const check = await runCheck(dir);
    expect(check.exitCode).toBe(0);
  });

  it("Given a name already taken, When add skill runs again, Then it exits 2 and writes nothing", async () => {
    const dir = await initializedRepo();
    await runAddSkill(dir, defaultSkillAnswers("demo-skill", false), {
      dryRun: false,
    });
    const skillDir = join(dir, ".agents", "skills", "demo-skill");
    const before = await readFile(join(skillDir, "SKILL.md"), "utf8");
    let error: unknown;
    try {
      await runAddSkill(
        dir,
        { ...defaultSkillAnswers("demo-skill", false), color: "#FF0000" },
        { dryRun: false },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(before);
    expect((await readdir(skillDir)).sort()).toEqual(
      ["SKILL.md", "agents", "assets"].sort(),
    );
  });

  it("Given an invalid name, When add skill runs, Then it exits 2 with the kebab-case spec and writes nothing", async () => {
    const dir = await initializedRepo();
    let error: unknown;
    try {
      await runAddSkill(dir, defaultSkillAnswers("Bad_Name", false), {
        dryRun: false,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    expect((error as CliError).message).toContain("kebab-case");
    expect(await pathExists(join(dir, ".agents", "skills", "Bad_Name"))).toBe(
      false,
    );
  });

  it("Given --dry-run, When add skill runs, Then the plan is reported, nothing is written and the exit code equals the real run", async () => {
    const dir = await initializedRepo();
    const answers = defaultSkillAnswers("demo-skill", false);
    const dry = await runAddSkill(dir, answers, { dryRun: true });
    expect(dry.exitCode).toBe(0);
    expect(dry.changes.map((change) => change.path)).toEqual([
      ".agents/skills/demo-skill/SKILL.md",
      ".agents/skills/demo-skill/agents/openai.yaml",
      ".agents/skills/demo-skill/assets/icon.svg",
      // the generator also projects to the harnesses, so the skill is usable
      // right away in copy mode as it already is in symlink mode
      ".claude/skills/demo-skill/SKILL.md",
      ".claude/skills/demo-skill/agents/openai.yaml",
      ".claude/skills/demo-skill/assets/icon.svg",
    ]);
    expect(await pathExists(join(dir, ".agents", "skills", "demo-skill"))).toBe(
      false,
    );
    const real = await runAddSkill(dir, answers, { dryRun: false });
    expect(real.exitCode).toBe(dry.exitCode);
    expect(real.changes).toEqual(dry.changes);
  });

  it("Given a one-letter and a 64-character name, When the default answers are derived, Then every field passes the frontmatter validation", () => {
    for (const name of ["x", "a".repeat(64)]) {
      const answers = defaultSkillAnswers(name, false);
      const length = [...answers.shortDescription].length;
      expect(length).toBeGreaterThanOrEqual(25);
      expect(length).toBeLessThanOrEqual(64);
      expect(() => parseSkillMarkdown(renderSkillMd(answers))).not.toThrow();
    }
  });

  it("Given a non-TTY terminal, When the CLI runs add skill --json, Then defaults apply, the output is one machine object and the skill exists", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    const { code, stdout } = await runCli(dir, [
      "add",
      "skill",
      "demo-skill",
      "--json",
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      command: string;
      mode: string;
      changes: { path: string; action: string }[];
      errors: unknown[];
      exitCode: number;
    };
    expect(report.command).toBe("add skill");
    expect(report.mode).toBe("copy");
    expect(report.errors).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(
      await pathExists(
        join(dir, ".agents", "skills", "demo-skill", "SKILL.md"),
      ),
    ).toBe(true);
  });

  it("Given --implicit alone, When the CLI runs add skill, Then it exits 2 before writing anything", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    const { code, stderr } = await runCli(dir, [
      "add",
      "skill",
      "demo-skill",
      "--implicit",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--read-only");
    expect(await pathExists(join(dir, ".agents", "skills", "demo-skill"))).toBe(
      false,
    );
  });
});
