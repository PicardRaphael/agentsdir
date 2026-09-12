import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { makeTempDir, runCli } from "../src/test-support/index.js";

const execFileAsync = promisify(execFile);

/**
 * `$propose-setup` walked end to end with scripted answers, on the two demo
 * repos the task names: a TypeScript one carrying a linter and a CI workflow,
 * and a Python one carrying nothing.
 *
 * The candidate list is the SAME on both repos; only the facts each repo
 * carries decide what survives. That is what makes this a test and not a
 * transcript: the exclusion rules of step 3 are applied mechanically here, and
 * a repo that proves a command drops the candidates that would restate it.
 */

type Stack = "typescript" | "python";

/** What step 1 records about a fact: the file it was read from, or an inference. */
interface Fact {
  what: string;
  /** "read" carries the file; "assumed" carries the convention it comes from. */
  kind: "read" | "assumed";
  source: string;
}

interface Inventory {
  facts: Fact[];
  /** Behaviours a tool of the repo already enforces — linter, CI, hooks. */
  enforced: string[];
}

type Kind = "hook" | "rule" | "agent";

interface Candidate {
  kind: Kind;
  name: string;
  /** Why it would earn its place; shown on the proposal line. */
  why: string;
  /** The facts the line rests on, each marked read or assumed. */
  evidence: Fact[];
  /** The behaviour it would cover — dropped when a repo tool already does. */
  covers: string;
}

/** A demo repo of the given stack, with the tooling the task describes. */
async function makeDemoRepo(stack: Stack): Promise<string> {
  const dir = await makeTempDir(`e2e-propose-${stack}`);
  await execFileAsync("git", ["-C", dir, "init"]);
  if (stack === "typescript") {
    // proven commands (declared scripts), a linter config, and a CI workflow
    // that runs both — the shape that must silence half the candidate list
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: "demo",
          private: true,
          scripts: { test: "vitest run", lint: "eslint ." },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "eslint.config.js"),
      "export default [{ rules: {} }];\n",
      "utf8",
    );
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(dir, ".github", "workflows", "ci.yml"),
      [
        "name: ci",
        "on: [push]",
        "jobs:",
        "  verify:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm run lint",
        "      - run: npm test",
        "",
      ].join("\n"),
      "utf8",
    );
  } else {
    // nothing declared: pyproject names no test runner and no linter, so the
    // stack conventions (pytest, ruff) stay assumptions this repo never proves
    await writeFile(
      join(dir, "pyproject.toml"),
      '[project]\nname = "demo"\n',
      "utf8",
    );
  }
  return dir;
}

/** Step 1 of the skill: read the repo, mark each fact read or assumed. */
async function inventory(dir: string, stack: Stack): Promise<Inventory> {
  const facts: Fact[] = [];
  const enforced: string[] = [];
  const manifest = await readFile(join(dir, ".agents.toml"), "utf8");
  facts.push({
    what: `stack ${stack === "typescript" ? "node" : "python"}`,
    kind: "read",
    source: ".agents.toml",
  });
  expect(manifest).toContain(stack === "typescript" ? '"node"' : '"python"');
  if (stack === "typescript") {
    const scripts = Object.keys(
      (
        JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts ?? {},
    );
    for (const script of scripts) {
      facts.push({
        what: `npm run ${script}`,
        kind: "read",
        source: "package.json",
      });
    }
    const ci = await readFile(
      join(dir, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    if (scripts.includes("lint")) {
      enforced.push("code style and import order");
    }
    if (ci.includes("npm test")) {
      enforced.push("running the test suite before merge");
    }
    facts.push({
      what: "CI runs lint and test on every push",
      kind: "read",
      source: ".github/workflows/ci.yml",
    });
  } else {
    // the stack's usual commands, which this repo declares nowhere
    facts.push({
      what: "pytest",
      kind: "assumed",
      source: "python convention",
    });
    facts.push({
      what: "ruff check .",
      kind: "assumed",
      source: "python convention",
    });
  }
  return { facts, enforced };
}

/**
 * The candidate list an agent would draft — identical for both repos. Two of
 * the five rest on the stack conventions, two would restate a tool, one comes
 * from the interview (step 2) and therefore from no file at all.
 */
function candidates(inv: Inventory): Candidate[] {
  const assumedTest = inv.facts.find(
    (fact) => fact.kind === "assumed" && fact.what === "pytest",
  );
  const assumedLint = inv.facts.find(
    (fact) => fact.kind === "assumed" && fact.what === "ruff check .",
  );
  const readFacts = inv.facts.filter((fact) => fact.kind === "read");
  return [
    {
      kind: "hook",
      name: "guard-deploy",
      why: "the user named a command no agent may ever run here",
      // the interview answers what no file states: that is the point of step 2
      evidence: [
        { what: "never run a deploy", kind: "read", source: "interview" },
      ],
      covers: "blocking a forbidden command",
    },
    {
      kind: "rule",
      name: "task-files",
      why: "agents left resolved task files behind twice, an observed failure",
      evidence: [
        {
          what: "resolved task files left in place",
          kind: "read",
          source: "interview",
        },
      ],
      covers: "deleting a task file on delivery",
    },
    {
      kind: "rule",
      name: "lint-style",
      why: "keep import order and line length consistent",
      evidence: assumedLint ? [assumedLint] : readFacts.slice(0, 1),
      covers: "code style and import order",
    },
    {
      kind: "rule",
      name: "run-tests",
      why: "make the agent run the suite before concluding",
      evidence: assumedTest ? [assumedTest] : readFacts.slice(0, 1),
      covers: "running the test suite before merge",
    },
    {
      kind: "agent",
      name: "changelog-writer",
      why: "writing the changelog is bulky and isolable",
      evidence: [
        {
          what: "changelog written by hand",
          kind: "read",
          source: "interview",
        },
      ],
      covers: "drafting the changelog",
    },
  ];
}

/**
 * Step 3 and step 4 applied mechanically: a candidate a repo tool already
 * enforces is dropped, and so is one resting on assumed facts alone.
 */
function survives(candidate: Candidate, inv: Inventory): boolean {
  if (inv.enforced.includes(candidate.covers)) {
    return false;
  }
  return candidate.evidence.some((fact) => fact.kind === "read");
}

/** Step 5: the accepted line goes through the generator its meta-skill calls. */
async function create(dir: string, candidate: Candidate): Promise<void> {
  const args =
    candidate.kind === "hook"
      ? [
          "add",
          "hook",
          "PreToolUse",
          "--name",
          candidate.name,
          "--matcher",
          "Bash",
        ]
      : candidate.kind === "rule"
        ? [
            "add",
            "rule",
            candidate.name,
            "--hook",
            `Read before ${candidate.covers}.`,
          ]
        : ["add", "agent", candidate.name, "--description", candidate.why];
  const run = await runCli(dir, args);
  expect(run.code, run.stderr).toBe(0);
}

describe.each<Stack>(["typescript", "python"])(
  "24 - propose-setup walked with scripted answers on a %s demo repo",
  (stack) => {
    it("Given a repo just initialized, When the proposal is drafted, filtered and the accepted lines created, Then check passes on the first try and nothing restates what a repo tool enforces", async () => {
      const dir = await makeDemoRepo(stack);
      const init = await runCli(dir, [
        "init",
        "--yes",
        "--mode",
        "copy",
        "--packs",
        "core,creator",
      ]);
      expect(init.code, init.stderr).toBe(0);
      // the end of init points at the skill that fills the structure
      expect(init.stdout).toContain("$propose-setup");
      const body = await readFile(
        join(dir, ".agents", "skills", "propose-setup", "SKILL.md"),
        "utf8",
      );
      expect(body).toContain(
        "EXCLUDE what a tool of this repo already enforces",
      );

      const inv = await inventory(dir, stack);
      const all = candidates(inv);
      const proposed = all.filter((candidate) => survives(candidate, inv));
      const dropped = all.filter((candidate) => !survives(candidate, inv));
      // every proposal line carries a reason and at least one fact it read
      for (const candidate of proposed) {
        expect(candidate.why).not.toBe("");
        expect(
          candidate.evidence.some((fact) => fact.kind === "read"),
          `${candidate.name} rests on assumed facts alone`,
        ).toBe(true);
      }
      // the two candidates that would restate a tool never reach the table
      expect(dropped.map((candidate) => candidate.name)).toEqual([
        "lint-style",
        "run-tests",
      ]);

      // step 4: one verdict per line — the sub-agent is refused here, and a
      // refused line is recorded, never written
      const refused = proposed.filter(
        (candidate) => candidate.kind === "agent" && stack === "python",
      );
      const accepted = proposed.filter(
        (candidate) => !refused.includes(candidate),
      );
      expect(accepted.length).toBeGreaterThan(0);
      // step 5: the accepted lines, one at a time, in the order they were
      // accepted — no kind outranks another
      for (const candidate of accepted) {
        await create(dir, candidate);
      }

      // step 6: mechanical validation, green on the first try
      const check = await runCli(dir, ["check"]);
      expect(check.code, check.stdout).toBe(0);
      expect(check.stdout).toContain("Check passed");

      // nothing the linter or the CI already covers became a written rule.
      // `tasks.md` is out of scope: `init` installs it and it POINTS at the
      // project commands, which is the opposite of restating what they check.
      const rulesDir = join(dir, ".agents", "rules");
      const ruleFiles: string[] = await readdir(rulesDir).catch(() => []);
      const written = accepted
        .filter((candidate) => candidate.kind === "rule")
        .map((candidate) => `${candidate.name}.md`);
      for (const file of written) {
        const source = await readFile(join(rulesDir, file), "utf8");
        expect(source, `${file} restates a tool`).not.toMatch(
          /lint|format|eslint|prettier/i,
        );
        // and never asserts a command this repo does not prove
        if (stack === "python") {
          expect(source, `${file} asserts an unproven command`).not.toMatch(
            /pytest|ruff/i,
          );
        }
      }
      expect(written).toEqual(["task-files.md"]);
      expect(ruleFiles).toContain("task-files.md");
      // the dropped candidates left nothing at all behind
      expect(ruleFiles).not.toContain("lint-style.md");
      expect(ruleFiles).not.toContain("run-tests.md");

      // a refused line left no file behind either
      const agentFiles: string[] = await readdir(
        join(dir, ".agents", "agents"),
      ).catch(() => []);
      expect(agentFiles.includes("changelog-writer.md")).toBe(
        stack === "typescript",
      );
    }, 30000);
  },
);
