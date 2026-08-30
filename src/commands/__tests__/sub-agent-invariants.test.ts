import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runSync } from "../sync.js";

async function initializedRepo(): Promise<string> {
  const dir = await makeTempDir("sub-agents");
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

/** Writes `.agents/agents/<file>` verbatim — the point is to write malformed ones. */
async function writeAgent(
  root: string,
  file: string,
  source: string,
): Promise<void> {
  await mkdir(join(root, ".agents", "agents"), { recursive: true });
  await writeFile(join(root, ".agents", "agents", file), source, "utf8");
}

/**
 * Writing a source without a sync leaves the projections stale, which fails
 * check for an unrelated reason. Cases that must come out green project first.
 */
async function writeAgentAndSync(
  root: string,
  file: string,
  source: string,
): Promise<void> {
  await writeAgent(root, file, source);
  await runSync(root, { dryRun: false });
}

const VALID = [
  "---",
  "name: reviewer",
  'description: "Delegate when a diff needs a second pair of eyes."',
  "color: blue",
  "model: inherit",
  "---",
  "",
  "You are Reviewer, a focused sub-agent.",
  "",
].join("\n");

describe("32 - sub-agent frontmatter (invariant 14)", () => {
  it("Given a repo with no .agents/agents directory, When check runs, Then the invariant stays silent and the check passes", async () => {
    const dir = await initializedRepo();
    const result = await runCheck(dir);
    expect(
      result.violations.filter((violation) =>
        violation.rule.startsWith("agent-"),
      ),
    ).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("Given a well-formed sub-agent, When check runs, Then no violation is reported", async () => {
    const dir = await initializedRepo();
    await writeAgentAndSync(dir, "reviewer.md", VALID);
    const result = await runCheck(dir);
    expect(
      result.violations.filter((violation) =>
        violation.rule.startsWith("agent-"),
      ),
    ).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("Given a sub-agent without a description, When check runs, Then it fails naming the file and the field", async () => {
    const dir = await initializedRepo();
    await writeAgent(
      dir,
      "reviewer.md",
      ["---", "name: reviewer", "---", "", "Body.", ""].join("\n"),
    );
    const result = await runCheck(dir);
    const violation = result.violations.find(
      (candidate) => candidate.rule === "agent-frontmatter",
    );
    expect(violation?.path).toBe(".agents/agents/reviewer.md");
    expect(violation?.message).toContain("`description`");
    expect(result.exitCode).toBe(1);
  });

  it("Given a sub-agent without a name, When check runs, Then it fails saying the harness ignores the file silently", async () => {
    const dir = await initializedRepo();
    await writeAgent(
      dir,
      "reviewer.md",
      [
        "---",
        'description: "Delegate for reviews."',
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
    const result = await runCheck(dir);
    const violation = result.violations.find(
      (candidate) => candidate.rule === "agent-frontmatter",
    );
    expect(violation?.message).toContain("`name`");
    expect(violation?.message).toContain("ignores the file");
    expect(result.exitCode).toBe(1);
  });

  it("Given a sub-agent with no frontmatter block at all, When check runs, Then the whole file is reported as ignored by the harness", async () => {
    const dir = await initializedRepo();
    await writeAgent(dir, "reviewer.md", "You are Reviewer.\n");
    const result = await runCheck(dir);
    const violation = result.violations.find(
      (candidate) => candidate.rule === "agent-frontmatter",
    );
    expect(violation?.message).toContain("frontmatter");
    expect(result.exitCode).toBe(1);
  });

  it("Given a sub-agent whose frontmatter is not valid YAML, When check runs, Then it is reported instead of crashing the check", async () => {
    const dir = await initializedRepo();
    await writeAgent(
      dir,
      "reviewer.md",
      ["---", "name: [unclosed", "---", "", "Body.", ""].join("\n"),
    );
    const result = await runCheck(dir);
    expect(
      result.violations.some(
        (candidate) => candidate.rule === "agent-frontmatter",
      ),
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("Given a sub-agent whose name differs from its file name, When check runs, Then the identity invariant fails", async () => {
    const dir = await initializedRepo();
    await writeAgent(
      dir,
      "reviewer.md",
      VALID.replace("name: reviewer", "name: critic"),
    );
    const result = await runCheck(dir);
    const violation = result.violations.find(
      (candidate) => candidate.rule === "agent-name-identity",
    );
    expect(violation?.message).toContain("critic");
    expect(violation?.message).toContain("reviewer.md");
    expect(result.exitCode).toBe(1);
  });

  it("Given a sub-agent name outside the Agent Skills grammar, When check runs, Then the name spec invariant fails", async () => {
    const dir = await initializedRepo();
    await writeAgent(
      dir,
      "Reviewer_1.md",
      VALID.replace("name: reviewer", "name: Reviewer_1"),
    );
    const result = await runCheck(dir);
    expect(
      result.violations.some(
        (candidate) => candidate.rule === "agent-name-spec",
      ),
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("Given several malformed sub-agents, When check runs, Then every offending file is listed, not just the first", async () => {
    const dir = await initializedRepo();
    await writeAgent(
      dir,
      "alpha.md",
      ["---", "name: alpha", "---", ""].join("\n"),
    );
    await writeAgent(dir, "beta.md", "no frontmatter at all\n");
    const result = await runCheck(dir);
    const paths = result.violations
      .filter((violation) => violation.rule.startsWith("agent-"))
      .map((violation) => violation.path);
    expect(paths).toContain(".agents/agents/alpha.md");
    expect(paths).toContain(".agents/agents/beta.md");
  });

  it("Given a non-markdown file in .agents/agents, When check runs, Then it is left alone", async () => {
    const dir = await initializedRepo();
    await writeAgent(dir, "reviewer.md", VALID);
    await writeAgentAndSync(dir, "notes.txt", "scratch notes, not an agent\n");
    const result = await runCheck(dir);
    expect(
      result.violations.filter((violation) =>
        violation.rule.startsWith("agent-"),
      ),
    ).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("Given a sub-agent created by add agent, When check runs, Then the generator's own output satisfies the invariant", async () => {
    const dir = await initializedRepo();
    const { runAddAgent } = await import("../add-agent.js");
    await runAddAgent(
      dir,
      {
        name: "release-captain",
        description: "Delegate when a release needs to be prepared end to end.",
        color: "blue",
        model: "inherit",
      },
      { dryRun: false },
    );
    const result = await runCheck(dir);
    expect(
      result.violations.filter((violation) =>
        violation.rule.startsWith("agent-"),
      ),
    ).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});
