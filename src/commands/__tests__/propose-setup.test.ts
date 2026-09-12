import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../../core/frontmatter.js";
import { resolveHookEvent } from "../../core/hook-registries.js";
import { FILTER_QUESTION } from "../../packs/creator.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
} from "../../test-support/index.js";
import { runAddHook } from "../add-hook.js";
import { runAddRule } from "../add-rule.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runPackAdd } from "../pack.js";

/**
 * `$propose-setup` is the step missing between "the architecture is installed"
 * and "the user knows what to put in it": after `init`, `.agents/` holds the
 * meta-skills and nothing else. The skill analyses the repo and puts a whole
 * proposal on the table — hooks, rules, sub-agents — each with the reason it
 * earns its place HERE, accepted or refused one line at a time.
 */

async function repoWithCreator(): Promise<string> {
  const dir = await makeTempDir("propose-setup");
  await runInit(dir, initAnswers(), { dryRun: false });
  await runPackAdd(dir, "creator", { dryRun: false });
  return dir;
}

async function skillBody(root: string): Promise<string> {
  const source = await readFile(
    join(root, ".agents", "skills", "propose-setup", "SKILL.md"),
    "utf8",
  );
  return parseSkillMarkdown(source).body;
}

async function reference(root: string, file: string): Promise<string> {
  return readFile(
    join(root, ".agents", "skills", "propose-setup", "references", file),
    "utf8",
  );
}

describe("24 - meta-skill propose-setup", () => {
  it("Given an initialized repo, When pack add creator runs, Then propose-setup is installed complete, locked as agentsdir, and check reports zero violations", async () => {
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
          join(dir, ".agents", "skills", "propose-setup", ...rel.split("/")),
        ),
        `propose-setup/${rel} missing`,
      ).toBe(true);
    }
    const lock = JSON.parse(
      await readFile(join(dir, "skills-lock.json"), "utf8"),
    ) as { skills: Record<string, Record<string, unknown>> };
    expect(lock.skills["propose-setup"]?.["sourceType"]).toBe("agentsdir");
    expect(lock.skills["propose-setup"]?.["computedHash"]).toMatch(
      /^[0-9a-f]{64}$/,
    );
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
    expect(check.exitCode).toBe(0);
  });

  it("Given the skill body, When inspected, Then it proposes hooks, rules and sub-agents, each carrying the reason it earns its place in THIS repo", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    expect(body).toContain("hooks, rules and sub-agents");
    expect(body).toContain("earn their place");
    expect(body).toContain("in THIS repo");
    // one table, one line per element, each line carrying its justification
    expect(body).toContain("ONE table, one line per element");
    expect(body).toContain("why it is needed in THIS repo");
    const rubric = await reference(dir, "rubrique.md");
    expect(rubric).toContain(
      "Every element says why it is needed in THIS repo",
    );
  });

  it("Given the proposal, When presented, Then every line gets its own verdict — accept, refuse or amend — and nothing is written before all of them have one", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    expect(body).toContain("a verdict PER LINE: accept, refuse, or");
    expect(body).toContain("amend");
    expect(body).toContain("Write nothing until every line has its");
    expect(body).toContain("Nothing is written before every");
    // the accepted subset only — a refusal is recorded, never written
    expect(body).toContain("Create the accepted lines only");
    const rubric = await reference(dir, "rubrique.md");
    expect(rubric).toContain("One verdict per line");
    expect(rubric).toContain("nothing written");
  });

  it("Given each proposed element, When justified, Then it cites the evidence it rests on and marks every fact read or assumed", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    // the sources the inventory reads, named one by one
    for (const source of [
      "stack marker files",
      "`package.json` scripts",
      "`.github/workflows/`",
      "linter and formatter configs",
      "recent commit subjects",
    ]) {
      expect(body, `${source} not inventoried`).toContain(source);
    }
    expect(body).toContain("Mark every fact `read`");
    expect(body).toContain("naming the file it comes from");
    expect(body).toContain("`assumed`");
    expect(body).toContain("each fact marked read or assumed");
    // an inference alone never carries an element to the table
    expect(body).toContain(
      "Never propose an element resting on `assumed` facts",
    );
    const rubric = await reference(dir, "rubrique.md");
    expect(rubric).toContain("none rests on assumed facts alone");
  });

  it("Given a repo whose tools already enforce a behaviour, When the proposal is drafted, Then that element is excluded instead of proposed", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    expect(body).toContain("EXCLUDE what a tool of this repo already enforces");
    for (const tool of [
      "a linter",
      "a formatter",
      "a type checker",
      "a CI step",
      "an existing hook",
      "harness",
    ]) {
      expect(body, `${tool} not excluded`).toContain(tool);
    }
    expect(body).toContain("never sends an agent to do a linter's job");
    expect(body).toContain("never writes a");
    expect(body).toContain("rule that restates a CI step");
    const interview = await reference(dir, "interview.md");
    expect(interview).toContain("already enforced mechanically");
    expect(interview).toContain("EXCLUDED from the proposal");
    const rubric = await reference(dir, "rubrique.md");
    expect(rubric).toContain(
      "Nothing a linter, a formatter, a type checker, a CI step, an existing",
    );
  });

  it("Given a repo that already carries rules or hooks, When the inventory runs, Then the skill completes the existing set and names what is already covered instead of duplicating it", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    for (const installed of [
      "`.agents/rules/`",
      "`.agents/hooks/`",
      "`.agents/agents/`",
      "`.agents/skills/`",
    ]) {
      expect(body, `${installed} not read`).toContain(installed);
    }
    expect(body).toContain("COMPLETE that set");
    expect(body).toContain("duplicates one");
    expect(body).toContain("never proposed, it is listed as already covered");
    const rubric = await reference(dir, "rubrique.md");
    expect(rubric).toContain(
      "Nothing that duplicates an existing rule, hook or sub-agent",
    );
  });

  it("Given the accepted lines, When they are created, Then each goes through its own meta-skill and no creation protocol is replayed here", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    const generate = body.indexOf("## 5. Generate, then write");
    expect(generate).toBeGreaterThan(-1);
    for (const creator of ["$create-hook", "$create-rule", "$create-agent"]) {
      expect(
        body.indexOf(creator, generate),
        `${creator} not delegated to at step 5`,
      ).toBeGreaterThan(generate);
    }
    expect(body).toContain("agentsdir add");
    expect(body).toContain("do not replay their protocol here");
    expect(body).toContain("never write the files by hand");
    // the accepted line travels with its reason: the creators finish the
    // interview, they never restart the analysis
    expect(body).toContain("they do not restart the analysis");
    const rubric = await reference(dir, "rubrique.md");
    expect(rubric).toContain("delegates to them and never bypasses them");
  });

  it("Given the interview bank, When inspected, Then it asks only the five questions the repo cannot answer itself", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    expect(body).toContain("Ask ONLY what the repo cannot answer");
    expect(body).toContain("references/interview.md");
    const interview = await reference(dir, "interview.md");
    expect(interview).toContain("Ask only what the repo cannot answer");
    expect(interview).toContain("What did the agents get wrong on this repo");
    expect(interview).toContain("already enforced mechanically");
    expect(interview).toContain("never run here");
    expect(interview).toContain("repeat by hand");
    expect(interview).toContain("off limits, generated or vendored");
    // asked BEFORE the table exists, or it only decorates a decision taken
    expect(body).toContain("BEFORE the proposal is drafted");
  });

  it("Given the routing step, When inspected, Then no artifact kind outranks another and the mix follows this repo and the request, with skills routed out", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    // a hook, a rule and a sub-agent each cover what the other two cannot:
    // ranking them by kind proposes an artifact instead of answering a need
    expect(body).toContain("No kind outranks another");
    expect(body).toContain("each cover what");
    expect(body).toContain("the three together, one of them, or none at");
    expect(body).toContain("never by the");
    expect(body).toContain("kind of artifact");
    expect(body).toContain("strength of the evidence");
    expect(body).toContain("out of scope here");
    expect(body).toContain("$create-skill");
    const rubric = await reference(dir, "rubrique.md");
    expect(rubric).toContain("No kind ranked above another");
    expect(rubric).toContain("what the other two kinds would");
  });

  it("Given the critique step, When inspected, Then every line faces the verbatim filter question and an over-long list is cut", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    expect(body).toContain(FILTER_QUESTION);
    expect(body).toContain("references/rubrique.md");
    expect(body).toContain("five founded elements beat fifteen generic ones");
    expect(body).toContain("accepted wholesale, then ignored");
    const rubric = await reference(dir, "rubrique.md");
    expect(rubric).toContain("▣");
    expect(rubric).toContain("Critique");
    expect(rubric).toContain("Few and founded");
  });

  it("Given the closing step, When inspected, Then it ends on agentsdir check and reports what was deliberately not created", async () => {
    const dir = await repoWithCreator();
    const body = await skillBody(dir);
    const closing = body.indexOf("## 6. Mechanical validation");
    expect(closing).toBeGreaterThan(-1);
    expect(body.indexOf("agentsdir check", closing)).toBeGreaterThan(closing);
    expect(body.indexOf("paste its", closing)).toBeGreaterThan(closing);
    expect(body.indexOf("what was NOT created", closing)).toBeGreaterThan(
      closing,
    );
    expect(body.indexOf("the omissions deliberate", closing)).toBeGreaterThan(
      closing,
    );
  });

  it("Given the accepted lines of a proposal, When the generators create them in the order the skill prescribes, Then check passes on the first try", async () => {
    const dir = await repoWithCreator();
    // hooks first, rules second — the order step 3 imposes — each artifact
    // landing through the generator its meta-skill calls at step 5
    const event = resolveHookEvent("PreToolUse");
    if (event === undefined) {
      throw new Error("PreToolUse missing from the matrix");
    }
    await runAddHook(
      dir,
      { event, slug: "guard-deploy", matcher: "Bash" },
      { dryRun: false },
    );
    await runAddRule(
      dir,
      {
        name: "release-steps",
        hook: "Read before cutting a release.",
        paths: ["src/**"],
      },
      { dryRun: false },
    );
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
    expect(check.exitCode).toBe(0);
    // and the set the next proposal must COMPLETE rather than double is now
    // exactly where step 1 tells the inventory to look
    expect(
      await pathExists(join(dir, ".agents", "rules", "release-steps.md")),
    ).toBe(true);
    expect(
      await pathExists(
        join(dir, ".agents", "hooks", "pretooluse-guard-deploy.mjs"),
      ),
    ).toBe(true);
  });
});
