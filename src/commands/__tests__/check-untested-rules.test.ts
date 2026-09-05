import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../exit-codes.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import type { Violation } from "../../core/validate.js";

/**
 * `check` is the CI gate of the product: a rule nobody asserts is a rule that
 * disappears at the next refactor without anyone seeing it. These seven had no
 * test at all.
 */
async function initializedRepo(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

/** A catalogue SKILL.md — every field `check` holds a managed skill to. */
function skillSource(
  name: string,
  overrides: Record<string, string> = {},
): string {
  const fields: Record<string, string> = {
    name,
    description: "Does X end to end. Use when the user asks to X.",
    "disable-model-invocation": "true",
    "display-name": '"Demo Skill"',
    "short-description": '"Does X end to end for the demo"',
    color: '"#1F4E8C"',
    icon: "terminal",
    "default-prompt": `"Use $${name} to do X."`,
    ...overrides,
  };
  const frontmatter = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const body = Array.from(
    { length: 14 },
    (_, index) => `Step ${index + 1}: do the thing precisely.`,
  ).join("\n");
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

async function writeSkill(
  root: string,
  folder: string,
  source: string,
): Promise<void> {
  await mkdir(join(root, ".agents", "skills", folder), { recursive: true });
  await writeFile(
    join(root, ".agents", "skills", folder, "SKILL.md"),
    source,
    "utf8",
  );
}

/** The violation carrying `rule`, or undefined — what each test asserts on. */
function violationFor(
  violations: Violation[],
  rule: string,
): Violation | undefined {
  return violations.find((candidate) => candidate.rule === rule);
}

describe("36 - the check rules nothing asserted: skills", () => {
  it("Given a skill folder with no SKILL.md, When check runs, Then skill-md-missing names the folder and the two ways out", async () => {
    const dir = await initializedRepo("rules-md-missing");
    await mkdir(join(dir, ".agents", "skills", "hollow"), { recursive: true });

    const result = await runCheck(dir);

    const violation = violationFor(result.violations, "skill-md-missing");
    expect(violation?.path).toBe(".agents/skills/hollow");
    expect(violation?.message).toContain("write it or delete the folder");
    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
  });

  it("Given a SKILL.md that cannot be read, When check runs, Then skill-md-unreadable says the file is there", async () => {
    // absent and unreadable call for opposite fixes; a directory in the file's
    // place is the portable way to make the read fail on every OS
    const dir = await initializedRepo("rules-md-unreadable");
    await mkdir(join(dir, ".agents", "skills", "locked", "SKILL.md"), {
      recursive: true,
    });

    const result = await runCheck(dir);

    const violation = violationFor(result.violations, "skill-md-unreadable");
    expect(violation?.path).toBe(".agents/skills/locked/SKILL.md");
    expect(violation?.message).toContain("cannot be read");
    expect(violation?.message).toContain("the file is there");
    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
  });

  it("Given a SKILL.md with no frontmatter block, When check runs, Then skill-frontmatter says which block is missing", async () => {
    const dir = await initializedRepo("rules-frontmatter");
    await writeSkill(dir, "bare", "No frontmatter at all, just prose.\n");

    const result = await runCheck(dir);

    const violation = violationFor(result.violations, "skill-frontmatter");
    expect(violation?.path).toBe(".agents/skills/bare/SKILL.md");
    expect(violation?.message).toContain("no frontmatter block");
    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
  });

  it("Given a skill whose name breaks the name grammar, When check runs, Then skill-name-spec quotes the name and the grammar", async () => {
    const dir = await initializedRepo("rules-name-spec");
    await writeSkill(
      dir,
      "-bad",
      [
        "---",
        "name: -bad",
        "description: Leading dash.",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );

    const result = await runCheck(dir);

    const violation = violationFor(result.violations, "skill-name-spec");
    expect(violation?.path).toBe(".agents/skills/-bad/SKILL.md");
    expect(violation?.message).toContain('"-bad"');
    expect(violation?.message).toContain("without a leading or trailing dash");
    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
  });

  it("Given a skill whose icon is not in the embedded set, When check runs, Then skill-unknown-icon names it and suggests one", async () => {
    const dir = await initializedRepo("rules-unknown-icon");
    await writeSkill(
      dir,
      "iconless",
      skillSource("iconless", { icon: "terminalx" }),
    );

    const result = await runCheck(dir);

    const violation = violationFor(result.violations, "skill-unknown-icon");
    expect(violation?.path).toBe(".agents/skills/iconless/SKILL.md");
    expect(violation?.message).toContain('Unknown icon "terminalx"');
    expect(violation?.message).toContain("Did you mean");
    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
  });
});

describe("36 - the check rules nothing asserted: AGENTS.md", () => {
  it("Given a repo whose AGENTS.md is gone, When check runs, Then agents-md-missing points at init", async () => {
    const dir = await initializedRepo("rules-agents-md");
    await rm(join(dir, "AGENTS.md"));

    const result = await runCheck(dir);

    const violation = violationFor(result.violations, "agents-md-missing");
    expect(violation?.path).toBe("AGENTS.md");
    expect(violation?.message).toContain("agentsdir init");
    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
  });

  it("Given an AGENTS.md whose rules-index block was deleted, When check runs, Then rules-index-missing points at sync", async () => {
    const dir = await initializedRepo("rules-index-missing");
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    const begin = agentsMd.indexOf("<!-- agentsdir:begin rules-index -->");
    const end = agentsMd.indexOf("<!-- agentsdir:end rules-index -->");
    expect(begin).toBeGreaterThan(-1);
    await writeFile(
      join(dir, "AGENTS.md"),
      agentsMd.slice(0, begin) +
        agentsMd.slice(end + "<!-- agentsdir:end rules-index -->".length),
      "utf8",
    );

    const result = await runCheck(dir);

    const violation = violationFor(result.violations, "rules-index-missing");
    expect(violation?.path).toBe("AGENTS.md");
    expect(violation?.message).toContain("agentsdir sync");
    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
  });
});
