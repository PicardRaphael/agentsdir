import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readManifest } from "../../core/manifest.js";
import { initAnswers, makeTempDir, runCli } from "../../test-support/index.js";
import { CLI_VERSION } from "../../version.js";
import { runInit, type InitAnswers } from "../init.js";

const execFileAsync = promisify(execFile);

async function makeGitRepo(): Promise<string> {
  const dir = await makeTempDir("init");
  await execFileAsync("git", ["-C", dir, "init"]);
  return dir;
}

/** The shared defaults plus what this suite exercises: a lint command and a stack. */
function answers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return initAnswers({
    commands: { test: "npm test", lint: "npm run lint" },
    stacks: ["node"],
    ...overrides,
  });
}

describe("04 - init command", () => {
  it("Given a fresh repo, When init runs, Then it generates the .agents tree, AGENTS.md, repo hygiene files and the manifest", async () => {
    const dir = await makeTempDir("init");
    const result = await runInit(dir, answers(), { dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(result.alreadyInitialized).toBe(false);
    for (const path of [
      ".agents/rules/tasks.md",
      ".agents/rules/memory.md",
      ".agents/tasks/README.md",
      ".agents/memory.template/MEMORY.md",
      ".agents/skills/.gitkeep",
      ".agents/agents/.gitkeep",
      ".agents/plan/.gitkeep",
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/rules/tasks.md",
      ".claude/rules/memory.md",
      ".gitignore",
      ".gitattributes",
      ".github/workflows/agents-check.yml",
      ".agents.toml",
    ]) {
      await expect(readFile(join(dir, path), "utf8")).resolves.toBeTypeOf(
        "string",
      );
    }
    await expect(readdir(join(dir, ".agents/memory"))).resolves.toEqual([]);
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("**demo** — A demo product.");
    expect(agentsMd).toContain("<!-- agentsdir:begin rules-index -->");
    const claudeMd = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("@AGENTS.md");
    const manifest = await readManifest(dir);
    expect(manifest.schema).toBe(1);
    expect(manifest.cliVersion).toBe(CLI_VERSION);
    expect(manifest.project).toEqual({ name: "demo", stack: ["node"] });
    expect(manifest.harness.enabled).toEqual(["claude", "codex", "cursor"]);
    expect(manifest.packs.installed).toEqual(["core"]);
    expect(manifest.projections.mode).toBe("copy");
    expect(Object.keys(manifest.projections.hashes)).toEqual(
      expect.arrayContaining([
        "CLAUDE.md",
        ".claude/rules/tasks.md",
        ".claude/rules/memory.md",
      ]),
    );
  });

  it("Given an existing AGENTS.md, When init runs, Then only the managed block is appended and the user content is preserved byte for byte", async () => {
    const dir = await makeTempDir("init");
    const original = "# Existing instructions\n\nDo not touch this.\n";
    await writeFile(join(dir, "AGENTS.md"), original, "utf8");
    const result = await runInit(dir, answers(), { dryRun: false });
    const updated = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(updated.startsWith(original)).toBe(true);
    expect(updated).toContain("<!-- agentsdir:begin rules-index -->");
    expect(updated).not.toContain("## Product");
    const change = result.changes.find((entry) => entry.path === "AGENTS.md");
    expect(change?.action).toBe("update-block");
  });

  it("Given an existing .gitignore, When init runs, Then agentsdir lines are appended without deduplicating the user's lines", async () => {
    const dir = await makeTempDir("init");
    const original = "node_modules/\n/.agents/memory/\n";
    await writeFile(join(dir, ".gitignore"), original, "utf8");
    await runInit(dir, answers(), { dryRun: false });
    const updated = await readFile(join(dir, ".gitignore"), "utf8");
    expect(updated.startsWith(original)).toBe(true);
    expect(updated).toContain("# agentsdir:begin ignore");
    expect(updated.match(/\/\.agents\/memory\//g)).toHaveLength(2);
  });

  it("Given existing .gitattributes and tasks/README.md, When init runs, Then no user file is overwritten, ever", async () => {
    const dir = await makeTempDir("init");
    await writeFile(join(dir, ".gitattributes"), "*.png binary\n", "utf8");
    const result = await runInit(dir, answers(), { dryRun: false });
    await expect(readFile(join(dir, ".gitattributes"), "utf8")).resolves.toBe(
      "*.png binary\n",
    );
    const change = result.changes.find(
      (entry) => entry.path === ".gitattributes",
    );
    expect(change?.action).toBe("skip-exists");
  });

  it("Given an already initialized repo, When init reruns, Then nothing changes and it reports already initialized with exit 0", async () => {
    const dir = await makeTempDir("init");
    await runInit(dir, answers(), { dryRun: false });
    const manifestBefore = await readFile(join(dir, ".agents.toml"));
    const result = await runInit(dir, answers({ productName: "other" }), {
      dryRun: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.alreadyInitialized).toBe(true);
    expect(result.changes).toEqual([]);
    const manifestAfter = await readFile(join(dir, ".agents.toml"));
    expect(manifestBefore.equals(manifestAfter)).toBe(true);
  });

  it("Given --dry-run on a fresh repo, When init runs, Then the plan is returned and nothing is written to disk", async () => {
    const dir = await makeTempDir("init");
    const result = await runInit(dir, answers(), { dryRun: true });
    expect(result.changes.length).toBeGreaterThan(0);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("Given a directory outside any git repo, When the CLI runs init, Then it exits with code 2 and an actionable message", async () => {
    const dir = await makeTempDir("init");
    const { code, stderr } = await runCli(dir, ["init", "--yes"]);
    expect(code).toBe(2);
    expect(stderr).toContain("git repository");
  });

  it("Given --yes in a git repo with a package.json, When the CLI runs init, Then defaults are applied and the next steps mention add skill and check", async () => {
    const dir = await makeGitRepo();
    await writeFile(join(dir, "package.json"), "{}\n", "utf8");
    const { code, stdout } = await runCli(dir, ["init", "--yes"]);
    expect(code).toBe(0);
    expect(stdout).toContain("add skill");
    expect(stdout).toContain("check");
    const manifest = await readManifest(dir);
    expect(manifest.project.stack).toEqual(["node"]);
    expect(manifest.harness.enabled).toEqual(["claude", "codex", "cursor"]);
    // creator is the default pack — since task 15 it installs its meta-skills
    expect(manifest.packs.installed).toEqual(["core", "creator"]);
    await expect(
      readFile(
        join(dir, ".agents", "skills", "create-skill", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("name: create-skill");
  });

  it("Given --harness claude and --packs core, When the CLI runs init, Then the questions are bypassed and the manifest records exactly those", async () => {
    const dir = await makeGitRepo();
    const { code } = await runCli(dir, [
      "init",
      "--yes",
      "--harness",
      "claude",
      "--packs",
      "core",
    ]);
    expect(code).toBe(0);
    const manifest = await readManifest(dir);
    expect(manifest.harness.enabled).toEqual(["claude"]);
    expect(manifest.packs.installed).toEqual(["core"]);
  });

  // Two full CLI inits in subprocesses (default packs include creator):
  // slower than the sibling tests, so it carries its own timeout.
  it("Given --mode symlink or copy, When the CLI runs init, Then the detection is bypassed and the manifest records the forced mode", async () => {
    const symlinkRepo = await makeGitRepo();
    await runCli(symlinkRepo, ["init", "--yes", "--mode", "symlink"]);
    expect((await readManifest(symlinkRepo)).projections.mode).toBe("symlink");
    const copyRepo = await makeGitRepo();
    await runCli(copyRepo, ["init", "--yes", "--mode", "copy"]);
    expect((await readManifest(copyRepo)).projections.mode).toBe("copy");
  }, 20000);

  it("Given --harness codex only, When init runs, Then no Claude projection is created and the manifest hashes stay empty", async () => {
    const dir = await makeTempDir("init");
    const result = await runInit(dir, answers({ harnesses: ["codex"] }), {
      dryRun: false,
    });
    expect(result.changes.some((change) => change.path === "CLAUDE.md")).toBe(
      false,
    );
    await expect(readFile(join(dir, "CLAUDE.md"), "utf8")).rejects.toThrow();
    const manifest = await readManifest(dir);
    expect(manifest.projections.hashes).toEqual({});
  });

  it("Given a foreign CLAUDE.md, When the CLI runs init, Then it stops with exit code 1 before writing anything", async () => {
    const dir = await makeGitRepo();
    await writeFile(join(dir, "CLAUDE.md"), "# Hand-written\n", "utf8");
    const { code, stderr } = await runCli(dir, [
      "init",
      "--yes",
      "--mode",
      "copy",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("CLAUDE.md");
    await expect(readFile(join(dir, "CLAUDE.md"), "utf8")).resolves.toBe(
      "# Hand-written\n",
    );
    const entries = await readdir(dir);
    expect(entries.sort()).toEqual([".git", "CLAUDE.md"]);
  });

  it("Given no TTY and no --yes, When the CLI runs init --dry-run, Then defaults are used with a note and nothing is written", async () => {
    const dir = await makeGitRepo();
    const { code, stdout, stderr } = await runCli(dir, ["init", "--dry-run"]);
    expect(code).toBe(0);
    expect(stderr).toContain("not a TTY");
    expect(stdout).toContain("Dry run — nothing was written.");
    const entries = await readdir(dir);
    expect(entries).toEqual([".git"]);
  });
});

describe("init - an agent can answer the interview without a terminal", () => {
  it("Given every answer as a flag, When init runs, Then AGENTS.md and the manifest carry them", async () => {
    const dir = await makeTempDir("init-agent");
    await execFileAsync("git", ["-C", dir, "init"]);
    await writeFile(
      join(dir, "package.json"),
      '{ "name": "mon-app" }\n',
      "utf8",
    );

    const { code } = await runCli(dir, [
      "init",
      "--yes",
      "--mode",
      "copy",
      "--name",
      "Mon App",
      "--description",
      "Tableau de bord de suivi.",
      "--dev",
      "pnpm dev",
      "--test",
      "pnpm test",
      "--lint",
      "pnpm lint",
    ]);
    expect(code).toBe(0);

    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("**Mon App** — Tableau de bord de suivi.");
    expect(agentsMd).toContain("pnpm test");
    expect(await readFile(join(dir, ".agents.toml"), "utf8")).toContain(
      'name = "Mon App"',
    );
  });
});
