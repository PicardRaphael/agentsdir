import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../../core/frontmatter.js";
import { FILTER_QUESTION } from "../../packs/creator.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
} from "../../test-support/index.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runPackAdd } from "../pack.js";

async function repoWithCreator(): Promise<string> {
  const dir = await makeTempDir("setup-context");
  await runInit(dir, initAnswers(), { dryRun: false });
  await runPackAdd(dir, "creator", { dryRun: false });
  return dir;
}

async function skillBody(root: string): Promise<string> {
  const source = await readFile(
    join(root, ".agents", "skills", "setup-context", "SKILL.md"),
    "utf8",
  );
  return parseSkillMarkdown(source).body;
}

async function reference(root: string, file: string): Promise<string> {
  return readFile(
    join(root, ".agents", "skills", "setup-context", "references", file),
    "utf8",
  );
}

describe("16 - meta-skill setup-context", () => {
  it("Given an initialized repo, When pack add creator runs, Then setup-context is installed complete, locked as agentsdir, and check reports zero violations", async () => {
    const dir = await repoWithCreator();
    for (const rel of [
      "SKILL.md",
      "references/rubrique.md",
      "references/interview.md",
      "agents/openai.yaml",
      "assets/icon.svg",
    ]) {
      expect(
        await pathExists(
          join(dir, ".agents", "skills", "setup-context", ...rel.split("/")),
        ),
        `setup-context/${rel} missing`,
      ).toBe(true);
    }
    const lock = JSON.parse(
      await readFile(join(dir, "skills-lock.json"), "utf8"),
    ) as { skills: Record<string, Record<string, unknown>> };
    expect(lock.skills["setup-context"]?.["sourceType"]).toBe("agentsdir");
    expect(lock.skills["setup-context"]?.["computedHash"]).toMatch(
      /^[0-9a-f]{64}$/,
    );
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
    expect(check.exitCode).toBe(0);
  });

  it("Given the inventory step, When inspected, Then the agent explores the real commands and structure and imports every known agent config without overwriting", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    expect(body).toContain("## 1. Inventory");
    expect(body).toContain("build, test and lint commands");
    expect(body).toContain("conventions the code actually follows");
    for (const config of [
      "CLAUDE.md",
      "AGENTS.md",
      ".cursor/rules",
      ".cursorrules",
      ".github/copilot-instructions.md",
    ]) {
      expect(body, `${config} not inventoried`).toContain(config);
    }
    expect(body).toContain("NEVER overwrite");
  });

  it("Given the interview bank, When inspected, Then it is limited to the five non-discoverable questions of the documented bank", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    expect(body).toContain("Ask ONLY what the repo cannot answer");
    const interview = await reference(dir, "interview.md");
    expect(interview).toContain("Ask only what the repo cannot answer");
    expect(interview).toContain("NEVER be run");
    expect(interview).toContain("What did the agent get wrong recently?");
    expect(interview).toContain("diverge from the ecosystem defaults");
    expect(interview).toContain("already enforced mechanically");
    expect(interview).toContain("Monorepo?");
    expect(interview).toContain("must be imported");
  });

  it("Given the drafting instructions, When inspected, Then the three families structure is imposed, the managed blocks are respected, and mechanically enforced content is excluded", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    expect(body).toContain("three families");
    expect(body).toContain("generic");
    expect(body).toContain("stack");
    expect(body).toContain("product");
    expect(body).toContain("agentsdir:begin");
    expect(body).toContain("Never edit inside the managed blocks");
    expect(body).toContain("agentsdir sync");
    expect(body).toContain("never send an LLM to do a linter's job");
  });

  it("Given the critique step, When inspected, Then every line faces the verbatim filter question and the proposal stays revisable before writing", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    expect(body).toContain(FILTER_QUESTION);
    expect(body).toContain("revisable proposal");
    expect(body).toContain("before writing");
    const rubric = await reference(dir, "rubrique.md");
    expect(rubric).toContain("▣");
    expect(rubric).toContain(FILTER_QUESTION);
    expect(rubric).toContain("pointers, never copies");
    expect(rubric).toContain("never-run commands");
  });

  it("Given an existing AGENTS.md, When inspected, Then improvement mode proposes changes without rewriting user sections, and a blank repo has its own path", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    expect(body).toContain("improvement mode");
    expect(body).toContain("keep the user's sections");
    expect(body).toContain("propose, never rewrite");
    expect(body).toContain("Blank repo");
    expect(body).toContain("agentsdir init");
  });

  it("Given the closing step, When inspected, Then the skill ends with agentsdir check and then suggests $create-skill and $create-hook", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    const closing = body.indexOf("## 6. Mechanical validation");
    expect(closing).toBeGreaterThan(-1);
    expect(body.indexOf("agentsdir check", closing)).toBeGreaterThan(closing);
    expect(body.lastIndexOf("$create-skill")).toBeGreaterThan(closing);
    expect(body.lastIndexOf("$create-hook")).toBeGreaterThan(closing);
  });
});
