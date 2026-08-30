import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderOpenAiYaml,
  renderSkillIcon,
} from "../../core/codex-metadata.js";
import { parseSkillMarkdown } from "../../core/frontmatter.js";
import { computeSkillHash } from "../../core/validate.js";
import { renderAgentsCheckWorkflow } from "../../templates/bootstrap.js";
import { runCheck } from "../check.js";
import { runInit, type InitAnswers } from "../init.js";
import { runSync } from "../sync.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentsdir-check-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  tempDirs = [];
});

function answers(): InitAnswers {
  return {
    productName: "demo",
    description: "A demo product.",
    commands: { test: "npm test" },
    harnesses: ["claude", "codex", "cursor"],
    packs: ["core"],
    mode: "copy",
    stacks: [],
  };
}

async function initializedRepo(): Promise<string> {
  const dir = await makeTempDir();
  await runInit(dir, answers(), { dryRun: false });
  return dir;
}

function skillSource(
  name: string,
  options: {
    fields?: Record<string, string>;
    bodyLines?: number;
    extraBody?: string;
  } = {},
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
    ...options.fields,
  };
  const frontmatter = Object.entries(fields)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const body = Array.from(
    { length: options.bodyLines ?? 14 },
    (_, index) => `Step ${index + 1}: do the thing precisely.`,
  ).join("\n");
  return `---\n${frontmatter}\n---\n\n${body}\n${options.extraBody ?? ""}`;
}

async function addSkill(
  root: string,
  folder: string,
  source: string,
): Promise<string> {
  const dir = join(root, ".agents", "skills", folder);
  await mkdir(join(dir, "agents"), { recursive: true });
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), source, "utf8");
  const { frontmatter } = parseSkillMarkdown(source);
  await writeFile(
    join(dir, "agents", "openai.yaml"),
    renderOpenAiYaml(frontmatter),
    "utf8",
  );
  await writeFile(
    join(dir, "assets", "icon.svg"),
    renderSkillIcon(frontmatter),
    "utf8",
  );
  return dir;
}

function rules(violations: { rule: string }[]): string[] {
  return violations.map((violation) => violation.rule);
}

function runCli(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          stdout,
          stderr,
          code: typeof error?.code === "number" ? error.code : 0,
        });
      },
    );
  });
}

async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(abs: string, rel: string): Promise<void> {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      const nextAbs = join(abs, entry.name);
      const nextRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(nextAbs, nextRel);
      } else if (entry.isFile()) {
        files.set(
          nextRel,
          createHash("sha256")
            .update(await readFile(nextAbs))
            .digest("hex"),
        );
      }
    }
  }
  await walk(dir, "");
  return files;
}

describe("07 - check command", () => {
  it("Given a freshly initialized repo with a valid skill, When check runs, Then it reports no violation and exits 0", async () => {
    const dir = await initializedRepo();
    await addSkill(dir, "demo", skillSource("demo"));
    // the helper writes the source by hand; sync projects it to the harnesses
    await runSync(dir, { dryRun: false });
    const result = await runCheck(dir);
    expect(result.violations).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("Given a projection copy modified by hand, When check runs, Then it names the file, the rule and the fix, and exits 1", async () => {
    const dir = await initializedRepo();
    const copy = join(dir, ".claude", "rules", "tasks.md");
    await writeFile(
      copy,
      `${await readFile(copy, "utf8")}\nedited by hand\n`,
      "utf8",
    );
    const result = await runCheck(dir);
    expect(result.exitCode).toBe(1);
    const drift = result.violations.find(
      (violation) => violation.path === ".claude/rules/tasks.md",
    );
    expect(drift?.rule).toBe("projection-modified");
    expect(drift?.message).toContain("agentsdir sync");
  });

  it("Given a skill folder whose name differs from its frontmatter name, When check runs, Then the name identity invariant fails", async () => {
    const dir = await initializedRepo();
    await addSkill(dir, "demo-two", skillSource("demo"));
    const result = await runCheck(dir);
    expect(rules(result.violations)).toContain("skill-name-identity");
  });

  it("Given invocation switches that disagree, When check runs, Then the parity invariant fails in both directions", async () => {
    const dir = await initializedRepo();
    await addSkill(
      dir,
      "expl",
      skillSource("expl", { fields: { "disable-model-invocation": "" } }),
    );
    await addSkill(
      dir,
      "impl",
      skillSource("impl", { fields: { implicit: "true" } }),
    );
    const result = await runCheck(dir);
    const parity = result.violations.filter(
      (violation) => violation.rule === "skill-invocation-parity",
    );
    expect(parity.map((violation) => violation.path).sort()).toEqual([
      ".agents/skills/expl/SKILL.md",
      ".agents/skills/impl/SKILL.md",
    ]);
  });

  it("Given an implicit skill declaring write-capable tools, When check runs, Then the read-only invariant fails — and stays silent without allowed-tools", async () => {
    const dir = await initializedRepo();
    await addSkill(
      dir,
      "quiet",
      skillSource("quiet", {
        fields: {
          implicit: "true",
          "disable-model-invocation": "",
          "allowed-tools": '["Read", "Write"]',
        },
      }),
    );
    await addSkill(
      dir,
      "calm",
      skillSource("calm", {
        fields: { implicit: "true", "disable-model-invocation": "" },
      }),
    );
    const result = await runCheck(dir);
    const readOnly = result.violations.filter(
      (violation) => violation.rule === "skill-implicit-read-only",
    );
    expect(readOnly.map((violation) => violation.path)).toEqual([
      ".agents/skills/quiet/SKILL.md",
    ]);
  });

  it("Given a skill body under 12 significant lines, When check runs, Then the depth invariant fails with the measured count", async () => {
    const dir = await initializedRepo();
    await addSkill(dir, "thin", skillSource("thin", { bodyLines: 5 }));
    const result = await runCheck(dir);
    const depth = result.violations.find(
      (violation) => violation.rule === "skill-body-depth",
    );
    expect(depth?.message).toContain("5 significant lines");
  });

  it("Given a referenced file mentioned at the end of a sentence, When check runs, Then the stripped path is reported missing until the file exists", async () => {
    const dir = await initializedRepo();
    const skillDir = await addSkill(
      dir,
      "refs",
      skillSource("refs", { extraBody: "\nSee references/guide.md.\n" }),
    );
    const before = await runCheck(dir);
    const missing = before.violations.find(
      (violation) => violation.rule === "skill-missing-reference",
    );
    expect(missing?.message).toContain('"references/guide.md"');
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(
      join(skillDir, "references", "guide.md"),
      "# Guide\n",
      "utf8",
    );
    const after = await runCheck(dir);
    expect(rules(after.violations)).not.toContain("skill-missing-reference");
  });

  it("Given Codex artifacts edited or deleted, When check runs, Then the byte-for-byte sync invariant fails for each artifact", async () => {
    const dir = await initializedRepo();
    const skillDir = await addSkill(dir, "demo", skillSource("demo"));
    const yamlPath = join(skillDir, "agents", "openai.yaml");
    await writeFile(
      yamlPath,
      `${await readFile(yamlPath, "utf8")}# edited\n`,
      "utf8",
    );
    await rm(join(skillDir, "assets", "icon.svg"));
    const result = await runCheck(dir);
    expect(result.exitCode).toBe(1);
    expect(rules(result.violations)).toEqual(
      expect.arrayContaining([
        "codex-artifact-drift",
        "codex-artifact-missing",
      ]),
    );
  });

  it("Given a rule missing from the index and an index entry pointing to a missing rule, When check runs, Then both directions fail", async () => {
    const dir = await initializedRepo();
    await writeFile(
      join(dir, ".agents", "rules", "extra.md"),
      "# Extra rule\n",
      "utf8",
    );
    const agentsMdPath = join(dir, "AGENTS.md");
    const agentsMd = await readFile(agentsMdPath, "utf8");
    await writeFile(
      agentsMdPath,
      agentsMd.replace(
        "<!-- agentsdir:end rules-index -->",
        "- `.agents/rules/ghost.md` — never.\n<!-- agentsdir:end rules-index -->",
      ),
      "utf8",
    );
    const result = await runCheck(dir);
    const outOfSync = result.violations.filter(
      (violation) => violation.rule === "rules-index-out-of-sync",
    );
    expect(outOfSync.map((violation) => violation.path).sort()).toEqual([
      ".agents/rules/extra.md",
      ".agents/rules/ghost.md",
    ]);
  });

  it("Given lock fingerprints, When a vendored skill drifts it is an error, and When agentsdir-installed content drifts it is only an info", async () => {
    const vendored = await initializedRepo();
    const vendoredDir = await addSkill(vendored, "vend", skillSource("vend"));
    await runSync(vendored, { dryRun: false });
    await writeFile(
      join(vendored, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          vend: {
            source: "org/repo",
            sourceType: "github",
            skillPath: ".agents/skills/vend/SKILL.md",
            computedHash: await computeSkillHash(vendoredDir),
          },
        },
      }),
      "utf8",
    );
    expect((await runCheck(vendored)).exitCode).toBe(0);
    await writeFile(join(vendoredDir, "notes.txt"), "local change\n", "utf8");
    const drifted = await runCheck(vendored);
    expect(drifted.exitCode).toBe(1);
    expect(rules(drifted.violations)).toContain("lock-drift");

    const installed = await initializedRepo();
    const installedDir = await addSkill(installed, "meta", skillSource("meta"));
    await runSync(installed, { dryRun: false });
    await writeFile(
      join(installed, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          meta: {
            source: "agentsdir",
            sourceType: "agentsdir",
            installedVersion: "0.0.0",
            skillPath: ".agents/skills/meta/SKILL.md",
            computedHash: await computeSkillHash(installedDir),
          },
        },
      }),
      "utf8",
    );
    await writeFile(join(installedDir, "notes.txt"), "local change\n", "utf8");
    const info = await runCheck(installed);
    // the new file also lacks its mirror until the next sync; what this test
    // pins down is that agentsdir-installed content never fails the lock
    expect(
      info.violations.filter(
        (violation) =>
          violation.rule.startsWith("lock-") && violation.severity === "error",
      ),
    ).toEqual([]);
    const local = info.violations.find(
      (violation) => violation.rule === "lock-local-change",
    );
    expect(local?.severity).toBe("info");
  });

  it("Given a repo full of violations, When check runs, Then no file is modified — strictly read-only", async () => {
    const dir = await initializedRepo();
    await addSkill(dir, "thin", skillSource("thin", { bodyLines: 3 }));
    const copy = join(dir, ".claude", "rules", "memory.md");
    await writeFile(copy, "no header any more\n", "utf8");
    const before = await snapshotTree(dir);
    const result = await runCheck(dir);
    expect(result.exitCode).toBe(1);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it("Given a git repo without a manifest, When the CLI runs check, Then it exits 2 pointing to agentsdir init", async () => {
    const dir = await makeTempDir();
    await execFileAsync("git", ["-C", dir, "init"]);
    const { code, stderr } = await runCli(dir, ["check"]);
    expect(code).toBe(2);
    expect(stderr).toContain("agentsdir init");
  });

  it("Given --json, When the CLI runs check on a drifted repo, Then stdout is a single machine-readable object and the exit code is 1", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    const copy = join(dir, ".claude", "rules", "tasks.md");
    await writeFile(copy, "hand edit\n", "utf8");
    const { code, stdout } = await runCli(dir, ["check", "--json"]);
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as {
      command: string;
      mode: string;
      changes: unknown[];
      errors: { rule: string }[];
      exitCode: number;
    };
    expect(report.command).toBe("check");
    expect(report.mode).toBe("copy");
    expect(report.changes).toEqual([]);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.exitCode).toBe(1);
  });

  it("Given the workflow emitted by init, When inspected, Then it runs npx agentsdir check", () => {
    expect(renderAgentsCheckWorkflow()).toContain("npx agentsdir check");
  });
});

describe("14 - copy projections are verified against the source of truth", () => {
  it("Given a rule edited in .agents/ without a sync, When check runs, Then the stale projection is reported and sync repairs it", async () => {
    const dir = await initializedRepo();
    const rule = join(dir, ".agents", "rules", "tasks.md");
    await writeFile(rule, `${await readFile(rule, "utf8")}\n- New line.\n`);
    const result = await runCheck(dir);
    expect(result.exitCode).toBe(1);
    const stale = result.violations.filter(
      (violation) => violation.rule === "projection-stale",
    );
    expect(stale.map((violation) => violation.path)).toEqual([
      ".claude/rules/tasks.md",
    ]);
    await runSync(dir, { dryRun: false });
    expect((await runCheck(dir)).exitCode).toBe(0);
    expect(
      await readFile(join(dir, ".claude", "rules", "tasks.md"), "utf8"),
    ).toContain("- New line.");
  });

  it("Given a rule deleted from .agents/, When check runs, Then its leftover projection is reported as an orphan and sync removes it", async () => {
    const dir = await initializedRepo();
    await writeFile(
      join(dir, ".agents", "rules", "extra.md"),
      "# Extra rule\n\nRead before shipping anything.\n",
      "utf8",
    );
    await runSync(dir, { dryRun: false });
    await rm(join(dir, ".agents", "rules", "extra.md"));
    const result = await runCheck(dir);
    expect(
      result.violations
        .filter((violation) => violation.rule === "projection-orphan")
        .map((violation) => violation.path),
    ).toEqual([".claude/rules/extra.md"]);
    const sync = await runSync(dir, { dryRun: false });
    expect(sync.exitCode).toBe(0);
    expect(
      sync.changes.some(
        (change) =>
          change.path === ".claude/rules/extra.md" &&
          change.action === "removed",
      ),
    ).toBe(true);
    await expect(
      readFile(join(dir, ".claude", "rules", "extra.md"), "utf8"),
    ).rejects.toThrow();
    expect((await runCheck(dir)).exitCode).toBe(0);
  });

  it("Given a projection edited by hand, When check runs, Then it is reported as modified, not as stale", async () => {
    const dir = await initializedRepo();
    const copy = join(dir, ".claude", "rules", "tasks.md");
    await writeFile(copy, `${await readFile(copy, "utf8")}\nedited by hand\n`);
    const result = await runCheck(dir);
    expect(result.exitCode).toBe(1);
    expect(
      result.violations
        .filter((violation) => violation.path === ".claude/rules/tasks.md")
        .map((violation) => violation.rule),
    ).toEqual(["projection-modified"]);
  });
});

function externalSkillSource(name: string): string {
  return `---\nname: ${name}\ndescription: A skill installed by another tool, open spec only.\n---\n\n# ${name}\n\nExternal content, no catalogue field.\n`;
}

describe("14 - external skill interop (open Agent Skills spec)", () => {
  it("Given a skill installed by another tool (name and description only), When check runs, Then it passes with an info notice and no error", async () => {
    const dir = await initializedRepo();
    await mkdir(join(dir, ".agents", "skills", "external-skill"), {
      recursive: true,
    });
    await writeFile(
      join(dir, ".agents", "skills", "external-skill", "SKILL.md"),
      externalSkillSource("external-skill"),
      "utf8",
    );
    // sync mirrors it to the harnesses without touching the skill folder
    await runSync(dir, { dryRun: false });
    const result = await runCheck(dir);
    expect(result.exitCode).toBe(0);
    const external = result.violations.filter((violation) =>
      violation.path.includes("external-skill"),
    );
    expect(rules(external)).toEqual(["skill-external"]);
    expect(external[0]?.severity).toBe("info");
  });

  it("Given an external skill whose folder and name disagree, When check runs, Then only the open-spec identity invariant fails", async () => {
    const dir = await initializedRepo();
    await mkdir(join(dir, ".agents", "skills", "other-folder"), {
      recursive: true,
    });
    await writeFile(
      join(dir, ".agents", "skills", "other-folder", "SKILL.md"),
      externalSkillSource("external-skill"),
      "utf8",
    );
    const result = await runCheck(dir);
    expect(result.exitCode).toBe(1);
    // only the skill contract matters here; the missing mirrors are a separate
    // concern (sync refuses to project a repo whose source is invalid)
    const errors = result.violations.filter(
      (violation) =>
        violation.severity === "error" && violation.rule.startsWith("skill-"),
    );
    expect(rules(errors)).toEqual(["skill-name-identity"]);
  });

  it("Given a catalogue skill missing its artifacts, When check runs, Then the catalogue contract still applies in full", async () => {
    const dir = await initializedRepo();
    await mkdir(join(dir, ".agents", "skills", "demo-skill"), {
      recursive: true,
    });
    await writeFile(
      join(dir, ".agents", "skills", "demo-skill", "SKILL.md"),
      skillSource("demo-skill"),
      "utf8",
    );
    const result = await runCheck(dir);
    expect(result.exitCode).toBe(1);
    expect(rules(result.violations)).toContain("codex-artifact-missing");
  });
});
