import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
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
import { detectSymlinkSupport } from "../../core/detect.js";
import { CliError } from "../../core/errors.js";
import { parseSkillMarkdown } from "../../core/frontmatter.js";
import { computeSkillHash } from "../../core/validate.js";
import { runCheck } from "../check.js";
import { runInit, type InitAnswers } from "../init.js";
import { runSync } from "../sync.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));

const probeDir = await mkdtemp(join(tmpdir(), "agentsdir-sync-probe-"));
const symlinkSupported = (await detectSymlinkSupport(probeDir)).supported;
await rm(probeDir, { recursive: true, force: true });

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentsdir-sync-"));
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

function answers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    productName: "demo",
    description: "A demo product.",
    commands: { test: "npm test" },
    harnesses: ["claude", "codex", "cursor"],
    packs: ["core"],
    mode: "copy",
    stacks: [],
    ...overrides,
  };
}

async function initializedRepo(): Promise<string> {
  const dir = await makeTempDir();
  await runInit(dir, answers(), { dryRun: false });
  return dir;
}

function skillSource(
  name: string,
  options: { bodyLines?: number } = {},
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
  };
  const frontmatter = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const body = Array.from(
    { length: options.bodyLines ?? 14 },
    (_, index) => `Step ${index + 1}: do the thing precisely.`,
  ).join("\n");
  return `---\n${frontmatter}\n---\n\n${body}\n`;
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

function actionsByPath(changes: { path: string; action: string }[]) {
  return new Map(changes.map((change) => [change.path, change.action]));
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

describe("08 - sync command", () => {
  it("Given drifted projections, a deleted Codex icon, an unindexed rule and a drifted vendored lock, When sync runs, Then it regenerates each of them per the manifest and check exits 0", async () => {
    const dir = await initializedRepo();
    await addSkill(dir, "demo", skillSource("demo"));
    const vendDir = await addSkill(dir, "vend", skillSource("vend"));
    await writeFile(
      join(dir, "skills-lock.json"),
      `${JSON.stringify(
        {
          version: 1,
          skills: {
            vend: {
              source: "org/repo",
              sourceType: "github",
              computedHash: await computeSkillHash(vendDir),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const copy = join(dir, ".claude", "rules", "tasks.md");
    await writeFile(
      copy,
      `${await readFile(copy, "utf8")}\nedited by hand\n`,
      "utf8",
    );
    await rm(join(dir, ".agents", "skills", "demo", "assets", "icon.svg"));
    await writeFile(
      join(dir, ".agents", "rules", "extra.md"),
      "# Extra rule\n\nRead before shipping anything.\n",
      "utf8",
    );
    await writeFile(join(vendDir, "notes.txt"), "local adaptation\n", "utf8");
    const result = await runSync(dir, { dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(result.violations).toEqual([]);
    const actions = actionsByPath(result.changes);
    expect(actions.get(".claude/rules/tasks.md")).toBe("updated");
    expect(actions.get(".agents/skills/demo/assets/icon.svg")).toBe("created");
    expect(actions.get(".claude/skills/demo/assets/icon.svg")).toBe("created");
    expect(actions.get(".claude/rules/extra.md")).toBe("created");
    expect(actions.get("AGENTS.md")).toBe("updated");
    expect(actions.get("skills-lock.json")).toBe("updated");
    expect(actions.get(".agents.toml")).toBe("updated");
    const check = await runCheck(dir);
    expect(
      check.violations.filter((violation) => violation.severity === "error"),
    ).toEqual([]);
    expect(check.exitCode).toBe(0);
  });

  it("Given a repo already in sync, When sync reruns, Then every file is reported ok and nothing is written (byte-for-byte comparison)", async () => {
    const dir = await initializedRepo();
    await addSkill(dir, "demo", skillSource("demo"));
    const first = await runSync(dir, { dryRun: false });
    expect(first.exitCode).toBe(0);
    const before = await snapshotTree(dir);
    const second = await runSync(dir, { dryRun: false });
    expect(second.exitCode).toBe(0);
    expect(second.changes.length).toBeGreaterThan(0);
    expect(second.changes.every((change) => change.action === "ok")).toBe(true);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it("Given drift, When sync runs with dry run, Then the full write plan is computed, nothing is written, and a real sync performs exactly the planned actions", async () => {
    const dir = await initializedRepo();
    await addSkill(dir, "demo", skillSource("demo"));
    await rm(join(dir, ".agents", "skills", "demo", "assets", "icon.svg"));
    const before = await snapshotTree(dir);
    const plan = await runSync(dir, { dryRun: true });
    expect(plan.exitCode).toBe(0);
    expect(await snapshotTree(dir)).toEqual(before);
    expect(plan.changes.some((change) => change.action !== "ok")).toBe(true);
    const real = await runSync(dir, { dryRun: false });
    expect(real.changes).toEqual(plan.changes);
  });

  it("Given the CLI with --dry-run, When sync runs, Then the plan is printed and the disk is untouched", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    await addSkill(dir, "demo", skillSource("demo"));
    const before = await snapshotTree(dir);
    const { code, stdout } = await runCli(dir, ["sync", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Dry run — nothing was written.");
    expect(stdout).toContain(".claude/skills/demo/SKILL.md");
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it("Given an invalid source alongside repairable drift, When sync runs, Then it fails with the validate diagnostic and writes nothing", async () => {
    const dir = await initializedRepo();
    await addSkill(dir, "thin", skillSource("thin", { bodyLines: 3 }));
    const copy = join(dir, ".claude", "rules", "tasks.md");
    await writeFile(
      copy,
      `${await readFile(copy, "utf8")}\nedited by hand\n`,
      "utf8",
    );
    const before = await snapshotTree(dir);
    const result = await runSync(dir, { dryRun: false });
    expect(result.exitCode).toBe(1);
    expect(result.violations.map((violation) => violation.rule)).toContain(
      "skill-body-depth",
    );
    expect(result.changes).toEqual([]);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it("Given repairs to perform, When sync runs, Then the sources are untouched: SKILL.md, rules and the free sections of AGENTS.md keep their bytes", async () => {
    const dir = await initializedRepo();
    await addSkill(dir, "demo", skillSource("demo"));
    const agentsMdPath = join(dir, "AGENTS.md");
    await writeFile(
      agentsMdPath,
      `${await readFile(agentsMdPath, "utf8")}\n## Team notes\n\nHand-written, hands off.\n`,
      "utf8",
    );
    await writeFile(
      join(dir, ".agents", "rules", "extra.md"),
      "# Extra rule\n\nRead before shipping anything.\n",
      "utf8",
    );
    const skillBytes = await readFile(
      join(dir, ".agents", "skills", "demo", "SKILL.md"),
    );
    const ruleBytes = await readFile(join(dir, ".agents", "rules", "tasks.md"));
    const result = await runSync(dir, { dryRun: false });
    expect(result.exitCode).toBe(0);
    const after = await readFile(agentsMdPath, "utf8");
    expect(after).toContain("## Team notes\n\nHand-written, hands off.\n");
    expect(after).toContain(
      "- `.agents/rules/extra.md` — before shipping anything.",
    );
    expect(
      (
        await readFile(join(dir, ".agents", "skills", "demo", "SKILL.md"))
      ).equals(skillBytes),
    ).toBe(true);
    expect(
      (await readFile(join(dir, ".agents", "rules", "tasks.md"))).equals(
        ruleBytes,
      ),
    ).toBe(true);
  });

  it("Given a dead entry injected in the rules index, When sync runs, Then the managed block is regenerated from .agents/rules/ and check exits 0", async () => {
    const dir = await initializedRepo();
    const agentsMdPath = join(dir, "AGENTS.md");
    await writeFile(
      agentsMdPath,
      (await readFile(agentsMdPath, "utf8")).replace(
        "<!-- agentsdir:end rules-index -->",
        "- `.agents/rules/ghost.md` — never.\n<!-- agentsdir:end rules-index -->",
      ),
      "utf8",
    );
    const result = await runSync(dir, { dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(actionsByPath(result.changes).get("AGENTS.md")).toBe("updated");
    const after = await readFile(agentsMdPath, "utf8");
    expect(after).not.toContain("ghost.md");
    expect(after).toContain(
      "- `.agents/rules/tasks.md` — before taking any task from `.agents/tasks/`.",
    );
    expect(after).toContain(
      "- `.agents/rules/memory.md` — before reading or writing `.agents/memory/`.",
    );
    expect((await runCheck(dir)).exitCode).toBe(0);
  });

  it("Given a vendored skill and an agentsdir-installed skill both modified, When sync runs, Then the github fingerprint is re-locked and the agentsdir fingerprint stays pinned", async () => {
    const dir = await initializedRepo();
    const vendDir = await addSkill(dir, "vend", skillSource("vend"));
    const metaDir = await addSkill(dir, "meta", skillSource("meta"));
    const pinned = await computeSkillHash(metaDir);
    await writeFile(
      join(dir, "skills-lock.json"),
      `${JSON.stringify(
        {
          version: 1,
          skills: {
            meta: {
              source: "agentsdir",
              sourceType: "agentsdir",
              installedVersion: "0.0.0",
              computedHash: pinned,
            },
            vend: {
              source: "org/repo",
              sourceType: "github",
              computedHash: await computeSkillHash(vendDir),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(vendDir, "notes.txt"), "local\n", "utf8");
    await writeFile(join(metaDir, "notes.txt"), "local\n", "utf8");
    const result = await runSync(dir, { dryRun: false });
    expect(result.exitCode).toBe(0);
    const lock = JSON.parse(
      await readFile(join(dir, "skills-lock.json"), "utf8"),
    ) as { skills: Record<string, { computedHash: string }> };
    expect(lock.skills["vend"]?.computedHash).toBe(
      await computeSkillHash(vendDir),
    );
    expect(lock.skills["meta"]?.computedHash).toBe(pinned);
    const check = await runCheck(dir);
    expect(check.exitCode).toBe(0);
    expect(check.violations.map((violation) => violation.rule)).toContain(
      "lock-local-change",
    );
  });

  it("Given a non-Markdown projection copy edited by hand, When sync runs, Then it refuses with exit code 1 instead of overwriting, and writes nothing", async () => {
    const dir = await initializedRepo();
    await addSkill(dir, "demo", skillSource("demo"));
    await runSync(dir, { dryRun: false });
    await writeFile(
      join(dir, ".claude", "skills", "demo", "assets", "icon.svg"),
      "<svg>hacked</svg>",
      "utf8",
    );
    const before = await snapshotTree(dir);
    const error = await runSync(dir, { dryRun: false }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect((error as CliError).message).toContain(
      ".claude/skills/demo/assets/icon.svg",
    );
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it.runIf(symlinkSupported)(
    "Given symlink mode with a deleted link and a re-pointed link, When sync runs, Then the links are recreated per the manifest and check exits 0",
    async () => {
      const dir = await makeTempDir();
      await execFileAsync("git", ["-C", dir, "init"]);
      await execFileAsync("git", [
        "-C",
        dir,
        "config",
        "core.symlinks",
        "true",
      ]);
      await runInit(dir, answers({ mode: "symlink" }), { dryRun: false });
      await addSkill(dir, "demo", skillSource("demo"));
      await unlink(join(dir, "CLAUDE.md"));
      await unlink(join(dir, ".claude", "agents"));
      await symlink("../.agents/rules", join(dir, ".claude", "agents"), "dir");
      const result = await runSync(dir, { dryRun: false });
      expect(result.exitCode).toBe(0);
      const actions = actionsByPath(result.changes);
      expect(actions.get("CLAUDE.md")).toBe("created");
      expect(actions.get(".claude/agents")).toBe("updated");
      expect(actions.get(".claude/rules")).toBe("ok");
      expect(
        (await readlink(join(dir, ".claude", "agents"))).replaceAll("\\", "/"),
      ).toBe("../.agents/agents");
      expect((await runCheck(dir)).exitCode).toBe(0);
    },
  );

  it("Given the codex harness only, When sync runs, Then Codex artifacts are regenerated but no Claude projection is created, and check exits 0", async () => {
    const dir = await makeTempDir();
    await runInit(dir, answers({ harnesses: ["codex"] }), { dryRun: false });
    await addSkill(dir, "demo", skillSource("demo"));
    await rm(join(dir, ".agents", "skills", "demo", "assets", "icon.svg"));
    const result = await runSync(dir, { dryRun: false });
    expect(result.exitCode).toBe(0);
    const actions = actionsByPath(result.changes);
    expect(actions.get(".agents/skills/demo/assets/icon.svg")).toBe("created");
    expect(
      result.changes.some(
        (change) =>
          change.path === "CLAUDE.md" || change.path.startsWith(".claude/"),
      ),
    ).toBe(false);
    await expect(readFile(join(dir, "CLAUDE.md"), "utf8")).rejects.toThrow();
    expect((await runCheck(dir)).exitCode).toBe(0);
  });

  it("Given --json, When the CLI runs sync on a drifted repo, Then stdout is a single machine-readable object with the per-file report", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    await addSkill(dir, "demo", skillSource("demo"));
    const { code, stdout } = await runCli(dir, ["sync", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      command: string;
      mode: string;
      changes: { path: string; action: string }[];
      errors: unknown[];
      exitCode: number;
    };
    expect(report.command).toBe("sync");
    expect(report.mode).toBe("copy");
    expect(report.errors).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.changes.some((change) => change.action === "created")).toBe(
      true,
    );
  });

  it("Given a git repo without a manifest, When the CLI runs sync, Then it exits 2 pointing to agentsdir init", async () => {
    const dir = await makeTempDir();
    await execFileAsync("git", ["-C", dir, "init"]);
    const { code, stderr } = await runCli(dir, ["sync"]);
    expect(code).toBe(2);
    expect(stderr).toContain("agentsdir init");
  });
});

describe("14 - external skill interop (open Agent Skills spec)", () => {
  it("Given a skill installed by another tool, When sync runs, Then the skill folder keeps its bytes, gets no Codex artifact, and check exits 0", async () => {
    const dir = await initializedRepo();
    const skillDir = join(dir, ".agents", "skills", "external-skill");
    await mkdir(skillDir, { recursive: true });
    const source = `---\nname: external-skill\ndescription: A skill installed by another tool, open spec only.\n---\n\n# External skill\n\nExternal content, no catalogue field.\n`;
    await writeFile(join(skillDir, "SKILL.md"), source, "utf8");
    const result = await runSync(dir, { dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(source);
    expect(await readdir(skillDir)).toEqual(["SKILL.md"]);
    expect((await runCheck(dir)).exitCode).toBe(0);
  });
});
