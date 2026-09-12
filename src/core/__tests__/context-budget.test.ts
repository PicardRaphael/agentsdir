import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/index.js";
import {
  CHARS_PER_TOKEN,
  MAX_BODY_TOKENS,
  MAX_DESCRIPTION_CHARS,
  measureContextBudget,
  type BudgetItem,
  type ContextBudget,
} from "../context-budget.js";
import { detectSymlinkSupport } from "../detect.js";

const probeDir = await makeTempDir("budget-probe");
const symlinkSupported = (await detectSymlinkSupport(probeDir)).supported;

interface SkillInput {
  description?: string;
  body?: string;
  references?: Record<string, string>;
  /** Files that never reach the context window and must not be billed. */
  assets?: Record<string, string>;
}

/** A repository built file by file: the budget reads the source of truth, not `init`. */
async function repo(): Promise<string> {
  return makeTempDir("budget");
}

async function writeAgentsMd(root: string, content: string): Promise<void> {
  await writeFile(join(root, "AGENTS.md"), content, "utf8");
}

async function writeSkill(
  root: string,
  name: string,
  input: SkillInput = {},
): Promise<void> {
  const dir = join(root, ".agents", "skills", name);
  await mkdir(dir, { recursive: true });
  const description =
    input.description ?? `Does ${name}. Use when the user asks for ${name}.`;
  const body = input.body ?? `# ${name}\n\nThe body of ${name}.\n`;
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\ndisplay-name: "${name}"\n---\n${body}`,
    "utf8",
  );
  for (const [file, content] of Object.entries(input.references ?? {})) {
    const abs = join(dir, "references", ...file.split("/"));
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  for (const [file, content] of Object.entries(input.assets ?? {})) {
    const abs = join(dir, ...file.split("/"));
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

async function writeRule(
  root: string,
  file: string,
  options: { paths?: string[] } = {},
): Promise<void> {
  await mkdir(join(root, ".agents", "rules"), { recursive: true });
  const frontmatter =
    options.paths === undefined
      ? ""
      : `---\npaths:\n${options.paths.map((glob) => `  - "${glob}"\n`).join("")}---\n`;
  await writeFile(
    join(root, ".agents", "rules", file),
    `${frontmatter}# Rule\n\nRead before touching what it covers.\n`,
    "utf8",
  );
}

async function writeSubAgent(root: string, file: string): Promise<void> {
  await mkdir(join(root, ".agents", "agents"), { recursive: true });
  await writeFile(
    join(root, ".agents", "agents", file),
    `---\nname: reviewer\ndescription: Reviews a diff.\n---\n\n# Reviewer\n\nThe delegation body.\n`,
    "utf8",
  );
}

function item(
  budget: ContextBudget,
  path: string,
  kind: BudgetItem["kind"],
): BudgetItem {
  const found = budget.items.find(
    (entry) => entry.path === path && entry.kind === kind,
  );
  expect(found, `item ${kind} of ${path} missing`).toBeDefined();
  return found as BudgetItem;
}

/** A body over the token budget but well under the 500 lines invariant 7 already guards. */
function longLineBody(tokens: number): string {
  const line = `${"budget ".repeat(20)}\n`;
  const lines = Math.ceil((tokens * CHARS_PER_TOKEN) / line.length);
  return `# Heavy\n\n${line.repeat(lines)}`;
}

describe("28 - context budget", () => {
  it("Given an installed configuration, When the budget is measured, Then every element carries its weight and the moment it is paid", async () => {
    const dir = await repo();
    await writeAgentsMd(dir, "# AGENTS.md\n\nEntry point.\n");
    await writeSkill(dir, "alpha", {
      references: { "guide.md": "# Guide\n\nDetail.\n" },
    });
    await writeRule(dir, "global.md");
    await writeRule(dir, "scoped.md", { paths: ["src/api/**"] });
    await writeSubAgent(dir, "reviewer.md");

    const budget = await measureContextBudget(dir);

    expect(
      budget.items.map((entry) => [entry.path, entry.kind, entry.when]),
    ).toEqual([
      [".agents/agents/reviewer.md", "agent-body", "on-invocation"],
      [".agents/agents/reviewer.md", "agent-metadata", "always"],
      [".agents/rules/global.md", "rule", "always"],
      [".agents/rules/scoped.md", "rule", "when-relevant"],
      [".agents/skills/alpha/SKILL.md", "skill-body", "on-invocation"],
      [".agents/skills/alpha/SKILL.md", "skill-metadata", "always"],
      [
        ".agents/skills/alpha/references/guide.md",
        "skill-reference",
        "on-invocation",
      ],
      ["AGENTS.md", "agents-md", "always"],
    ]);
    for (const entry of budget.items) {
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.tokens).toBeGreaterThan(0);
    }
  });

  it("Given a rule with a paths scope and one without, When the budget is measured, Then only the scoped rule is paid when relevant", async () => {
    // the mutation this kills: reading every rule as "when relevant", which
    // under-reports the always-paid total by the whole of the unscoped rules
    const dir = await repo();
    await writeRule(dir, "unscoped.md");
    await writeRule(dir, "scoped.md", { paths: ["src/**"] });

    const budget = await measureContextBudget(dir);

    expect(item(budget, ".agents/rules/unscoped.md", "rule").when).toBe(
      "always",
    );
    expect(item(budget, ".agents/rules/scoped.md", "rule").when).toBe(
      "when-relevant",
    );
    expect(budget.totals.always.items).toBe(1);
    expect(budget.totals.whenRelevant.items).toBe(1);
  });

  it("Given a skill, When its startup cost is measured, Then it is the name and description alone, not the catalogue fields around them", async () => {
    const dir = await repo();
    const description = "Does alpha end to end. Use when the user asks alpha.";
    await writeSkill(dir, "alpha", { description });

    const budget = await measureContextBudget(dir);

    const metadata = item(
      budget,
      ".agents/skills/alpha/SKILL.md",
      "skill-metadata",
    );
    expect(metadata.bytes).toBe(
      Buffer.byteLength(`alpha${description}`, "utf8"),
    );

    // the catalogue fields are read by this CLI, never loaded at startup:
    // growing one by 400 characters must not move the startup cost by a byte
    const path = join(dir, ".agents", "skills", "alpha", "SKILL.md");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        'display-name: "alpha"',
        `display-name: "alpha"\ndefault-prompt: "${"x".repeat(400)}"`,
      ),
      "utf8",
    );
    expect(
      item(
        await measureContextBudget(dir),
        ".agents/skills/alpha/SKILL.md",
        "skill-metadata",
      ).bytes,
    ).toBe(metadata.bytes);
  });

  it("Given a skill body, When it is measured, Then the frontmatter is excluded from what an invocation pays", async () => {
    const dir = await repo();
    const body = "# Alpha\n\nThe procedure.\n";
    await writeSkill(dir, "alpha", { body });

    const budget = await measureContextBudget(dir);

    expect(
      item(budget, ".agents/skills/alpha/SKILL.md", "skill-body").bytes,
    ).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("Given the three moments of payment, When the totals are computed, Then the every-session total is distinguished from the general total", async () => {
    const dir = await repo();
    await writeAgentsMd(dir, "# AGENTS.md\n\nEntry point.\n");
    await writeSkill(dir, "alpha", {
      references: { "guide.md": "# Guide\n\nDetail.\n" },
    });
    await writeRule(dir, "scoped.md", { paths: ["src/**"] });

    const { totals } = await measureContextBudget(dir);

    expect(totals.always.items).toBe(2);
    expect(totals.onInvocation.items).toBe(2);
    expect(totals.whenRelevant.items).toBe(1);
    expect(totals.all.items).toBe(5);
    expect(totals.all.tokens).toBe(
      totals.always.tokens +
        totals.onInvocation.tokens +
        totals.whenRelevant.tokens,
    );
    // the distinction the report exists for: a session pays the first, not the last
    expect(totals.always.tokens).toBeLessThan(totals.all.tokens);
  });

  it("Given the projections of the harnesses, When the budget is measured, Then only the source of truth is counted", async () => {
    const dir = await repo();
    await writeAgentsMd(dir, "# AGENTS.md\n\nEntry point.\n");
    await mkdir(join(dir, ".claude", "rules"), { recursive: true });
    await writeFile(join(dir, "CLAUDE.md"), "@AGENTS.md\n", "utf8");
    await writeFile(
      join(dir, ".claude", "rules", "copy.md"),
      "# Rule\n\nA copy of the source.\n",
      "utf8",
    );

    const budget = await measureContextBudget(dir);

    expect(budget.items.map((entry) => entry.path)).toEqual(["AGENTS.md"]);
  });

  it("Given a description over the spec bound, When the budget is measured, Then the overrun is signalled with its figure", async () => {
    const dir = await repo();
    await writeSkill(dir, "at-bound", {
      description: "x".repeat(MAX_DESCRIPTION_CHARS),
    });
    await writeSkill(dir, "over-bound", {
      description: "x".repeat(MAX_DESCRIPTION_CHARS + 1),
    });

    const { bounds } = await measureContextBudget(dir);

    expect(bounds).toHaveLength(1);
    expect(bounds[0]?.path).toBe(".agents/skills/over-bound/SKILL.md");
    expect(bounds[0]?.rule).toBe("skill-description-length");
    expect(bounds[0]?.message).toContain(String(MAX_DESCRIPTION_CHARS + 1));
  });

  it("Given a body over the token budget but under 500 lines, When the budget is measured, Then the overrun is signalled anyway", async () => {
    // the case the line invariant cannot see: few lines, each very long
    const dir = await repo();
    await writeSkill(dir, "heavy", {
      body: longLineBody(MAX_BODY_TOKENS + 500),
    });
    await writeSkill(dir, "light", { body: longLineBody(100) });

    const budget = await measureContextBudget(dir);

    const body = item(budget, ".agents/skills/heavy/SKILL.md", "skill-body");
    expect(body.lines).toBeLessThan(500);
    expect(body.tokens).toBeGreaterThan(MAX_BODY_TOKENS);
    expect(budget.bounds.map((bound) => bound.path)).toEqual([
      ".agents/skills/heavy/SKILL.md",
    ]);
    expect(budget.bounds[0]?.rule).toBe("skill-body-tokens");
  });

  it("Given files that never reach the window, When the budget is measured, Then scripts and assets are not billed", async () => {
    const dir = await repo();
    await writeSkill(dir, "alpha", {
      references: { "guide.md": "# Guide\n\nDetail.\n" },
      assets: {
        "assets/icon.svg": "<svg></svg>\n",
        "scripts/run.mjs": "process.exit(0);\n",
        "agents/openai.yaml": "interface: {}\n",
      },
    });

    const budget = await measureContextBudget(dir);

    expect(
      budget.items.filter((entry) => entry.kind === "skill-reference"),
    ).toHaveLength(1);
    expect(budget.items.some((entry) => entry.path.includes("assets/"))).toBe(
      false,
    );
    expect(budget.items.some((entry) => entry.path.includes("scripts/"))).toBe(
      false,
    );
  });

  it("Given a repository with nothing installed, When the budget is measured, Then it is empty rather than an error", async () => {
    const dir = await repo();

    const budget = await measureContextBudget(dir);

    expect(budget.items).toEqual([]);
    expect(budget.bounds).toEqual([]);
    expect(budget.totals.all).toEqual({ items: 0, bytes: 0, tokens: 0 });
  });

  it("Given a SKILL.md whose frontmatter is broken, When the budget is measured, Then the file still weighs what it weighs", async () => {
    const dir = await repo();
    await mkdir(join(dir, ".agents", "skills", "broken"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "broken", "SKILL.md"),
      "# No frontmatter\n\nStill loaded by the harness.\n",
      "utf8",
    );

    const budget = await measureContextBudget(dir);

    expect(
      budget.items.filter((entry) => entry.kind === "skill-metadata"),
    ).toHaveLength(0);
    expect(
      item(budget, ".agents/skills/broken/SKILL.md", "skill-body").bytes,
    ).toBeGreaterThan(0);
  });

  it.runIf(symlinkSupported)(
    "Given a skill folder that is a symlink, When the budget is measured, Then nothing outside the repository is billed to it",
    async () => {
      const outside = await makeTempDir("budget-outside");
      await mkdir(join(outside, "elsewhere"), { recursive: true });
      await writeFile(
        join(outside, "elsewhere", "SKILL.md"),
        "---\nname: elsewhere\ndescription: Outside.\n---\n\n# Elsewhere\n",
        "utf8",
      );
      const dir = await repo();
      await mkdir(join(dir, ".agents", "skills"), { recursive: true });
      await symlink(
        join(outside, "elsewhere"),
        join(dir, ".agents", "skills", "elsewhere"),
        "dir",
      );

      const budget = await measureContextBudget(dir);

      expect(budget.items).toEqual([]);
    },
  );

  it("Given a repository of 60 skills, When the budget is measured, Then the measure itself stays negligible", async () => {
    const dir = await repo();
    await writeAgentsMd(dir, "# AGENTS.md\n\nEntry point.\n");
    for (let index = 0; index < 60; index += 1) {
      await writeSkill(dir, `skill-${String(index).padStart(2, "0")}`, {
        references: { "guide.md": "# Guide\n\nDetail.\n".repeat(40) },
      });
    }

    const started = performance.now();
    const budget = await measureContextBudget(dir);
    const elapsed = performance.now() - started;

    // 60 metadata + 60 bodies + 60 references + AGENTS.md
    expect(budget.totals.all.items).toBe(181);
    expect(budget.totals.always.items).toBe(61);
    // a bound loose enough never to flake, tight enough to catch a measure
    // that reads the tree more than once; the observed figure is in the task
    // verification and in docs/conventions.md
    expect(elapsed).toBeLessThan(5000);
  });
});
