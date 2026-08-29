import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../core/errors.js";
import { parseSkillMarkdown } from "../../core/frontmatter.js";
import { readManifest } from "../../core/manifest.js";
import { runCheck } from "../check.js";
import { runInit, type InitAnswers } from "../init.js";
import { runSync } from "../sync.js";
import { resolveInstallablePack, runPackAdd, runPackRemove } from "../pack.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentsdir-pack-"));
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

function initAnswers(packs: string[] = ["core", "creator"]): InitAnswers {
  return {
    productName: "demo",
    description: "A demo product.",
    commands: { test: "npm test" },
    harnesses: ["claude", "codex", "cursor"],
    packs,
    mode: "copy",
    stacks: [],
  };
}

async function initializedRepo(packs?: string[]): Promise<string> {
  const dir = await makeTempDir();
  await runInit(dir, initAnswers(packs), { dryRun: false });
  return dir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function exitCodeOf(error: unknown): number {
  expect(error).toBeInstanceOf(CliError);
  return (error as CliError).exitCode;
}

describe("11 - pack verification", () => {
  it("Given an initialized repo, When pack add verification runs, Then skill, references, script, rule, artifacts, index, lock and manifest are installed", async () => {
    const dir = await initializedRepo();
    const result = await runPackAdd(dir, "verification", { dryRun: false });
    expect(result.exitCode).toBe(0);
    for (const path of [
      ".agents/skills/verify/SKILL.md",
      ".agents/skills/verify/references/proof-matrix.md",
      ".agents/skills/verify/scripts/build-report.mjs",
      ".agents/skills/verify/agents/openai.yaml",
      ".agents/skills/verify/assets/icon.svg",
      ".agents/rules/verification.md",
    ]) {
      expect(await pathExists(join(dir, ...path.split("/")))).toBe(true);
    }
    const skill = parseSkillMarkdown(
      await readFile(
        join(dir, ".agents", "skills", "verify", "SKILL.md"),
        "utf8",
      ),
    );
    expect(skill.frontmatter.name).toBe("verify");
    expect(skill.frontmatter.defaultPrompt).toContain("$verify");
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain(".agents/rules/verification.md");
    const lock = JSON.parse(
      await readFile(join(dir, "skills-lock.json"), "utf8"),
    ) as { skills: Record<string, Record<string, unknown>> };
    expect(lock.skills["verify"]?.["sourceType"]).toBe("agentsdir");
    expect(lock.skills["verify"]?.["installedVersion"]).toBeDefined();
    expect(lock.skills["verify"]?.["computedHash"]).toMatch(/^[0-9a-f]{64}$/);
    const manifest = await readManifest(dir);
    expect(manifest.packs.installed).toContain("verification");
  });

  it("Given the pack just installed, When check runs, Then there is not a single violation — info included", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "verification", { dryRun: false });
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
    expect(check.exitCode).toBe(0);
  });

  it("Given the pack just installed, When sync dry-runs, Then artifacts, index and lock are already in step (same bytes as pack add)", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "verification", { dryRun: false });
    const sync = await runSync(dir, { dryRun: true });
    expect(sync.exitCode).toBe(0);
    for (const path of [
      ".agents/skills/verify/agents/openai.yaml",
      ".agents/skills/verify/assets/icon.svg",
      "AGENTS.md",
      "skills-lock.json",
    ]) {
      const change = sync.changes.find((entry) => entry.path === path);
      expect(change?.action).toBe("ok");
    }
  });

  it("Given a proof matrix, When the report script runs from the repo root with plain Node, Then it writes a standalone HTML report", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "verification", { dryRun: false });
    const matrix = {
      title: "Demo verification",
      criteria: [
        {
          criterion: "Build passes",
          step: "npm run build",
          evidence: "exited 0 <ok>",
          verdict: "PASS",
        },
        {
          criterion: "Docs updated",
          step: "manual inspection",
          evidence: "",
          verdict: "NOT PROVEN",
        },
      ],
    };
    await writeFile(join(dir, "matrix.json"), JSON.stringify(matrix), "utf8");
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        ".agents/skills/verify/scripts/build-report.mjs",
        "matrix.json",
        ".agents/output/report.html",
      ],
      { cwd: dir },
    );
    expect(stdout).toContain("Report written");
    const html = await readFile(
      join(dir, ".agents", "output", "report.html"),
      "utf8",
    );
    expect(html).toContain("Demo verification");
    expect(html).toContain("NOT PROVEN");
    expect(html).toContain("&lt;ok&gt;");
    expect(html).toContain("1 PASS");
  });

  it("Given the pack installed, When pack remove verification runs, Then skill, rule, index line, lock entry and manifest entry are cleanly removed", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "verification", { dryRun: false });
    const result = await runPackRemove(dir, "verification", {
      force: false,
      dryRun: false,
    });
    expect(result.exitCode).toBe(0);
    expect(await pathExists(join(dir, ".agents", "skills", "verify"))).toBe(
      false,
    );
    expect(
      await pathExists(join(dir, ".agents", "rules", "verification.md")),
    ).toBe(false);
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain(".agents/rules/verification.md");
    expect(await pathExists(join(dir, "skills-lock.json"))).toBe(false);
    const manifest = await readManifest(dir);
    expect(manifest.packs.installed).not.toContain("verification");
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
  });

  it("Given pack files modified locally, When pack remove runs, Then it exits 1 removing nothing — and --force removes anyway", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "verification", { dryRun: false });
    const skillMd = join(dir, ".agents", "skills", "verify", "SKILL.md");
    await writeFile(
      skillMd,
      `${await readFile(skillMd, "utf8")}\nLocal note.\n`,
    );
    let error: unknown;
    try {
      await runPackRemove(dir, "verification", { force: false, dryRun: false });
    } catch (caught) {
      error = caught;
    }
    expect(exitCodeOf(error)).toBe(1);
    expect((error as CliError).message).toContain("SKILL.md");
    expect(await pathExists(skillMd)).toBe(true);
    const manifest = await readManifest(dir);
    expect(manifest.packs.installed).toContain("verification");
    const forced = await runPackRemove(dir, "verification", {
      force: true,
      dryRun: false,
    });
    expect(forced.exitCode).toBe(0);
    expect(await pathExists(join(dir, ".agents", "skills", "verify"))).toBe(
      false,
    );
  });

  it("Given usage errors, When pack add/remove run, Then they exit 2: already installed, unknown, not-yet pack, core, not installed", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "verification", { dryRun: false });
    let error: unknown;
    try {
      await runPackAdd(dir, "verification", { dryRun: false });
    } catch (caught) {
      error = caught;
    }
    expect(exitCodeOf(error)).toBe(2);
    expect(() => resolveInstallablePack("nope")).toThrowError(/Unknown pack/);
    expect(() => resolveInstallablePack("creator")).toThrowError(
      /no installable content/,
    );
    expect(() => resolveInstallablePack("core")).toThrowError(
      /base installation/,
    );
    try {
      error = undefined;
      await runPackRemove(dir, "changelog", { force: false, dryRun: false });
    } catch (caught) {
      error = caught;
    }
    expect(exitCodeOf(error)).toBe(2);
  });

  it("Given --dry-run, When pack add and remove run, Then nothing is written and the plans equal the real runs", async () => {
    const dir = await initializedRepo();
    const dryAdd = await runPackAdd(dir, "verification", { dryRun: true });
    expect(dryAdd.exitCode).toBe(0);
    expect(await pathExists(join(dir, ".agents", "skills", "verify"))).toBe(
      false,
    );
    const realAdd = await runPackAdd(dir, "verification", { dryRun: false });
    expect(realAdd.changes).toEqual(dryAdd.changes);
    const dryRemove = await runPackRemove(dir, "verification", {
      force: false,
      dryRun: true,
    });
    expect(await pathExists(join(dir, ".agents", "skills", "verify"))).toBe(
      true,
    );
    const realRemove = await runPackRemove(dir, "verification", {
      force: false,
      dryRun: false,
    });
    expect(realRemove.changes).toEqual(dryRemove.changes);
  });

  it("Given a copy-mode repo initialized with the pack, When pack remove runs, Then the .claude copies and their fingerprints go away and check stays clean", async () => {
    const dir = await initializedRepo(["core", "creator", "verification"]);
    expect(
      await pathExists(join(dir, ".claude", "skills", "verify", "SKILL.md")),
    ).toBe(true);
    const before = await readManifest(dir);
    expect(
      Object.keys(before.projections.hashes).some((key) =>
        key.startsWith(".claude/skills/verify/"),
      ),
    ).toBe(true);
    const result = await runPackRemove(dir, "verification", {
      force: false,
      dryRun: false,
    });
    expect(result.exitCode).toBe(0);
    expect(await pathExists(join(dir, ".claude", "skills", "verify"))).toBe(
      false,
    );
    expect(
      await pathExists(join(dir, ".claude", "rules", "verification.md")),
    ).toBe(false);
    const after = await readManifest(dir);
    expect(
      Object.keys(after.projections.hashes).some(
        (key) =>
          key.startsWith(".claude/skills/verify/") ||
          key === ".claude/rules/verification.md",
      ),
    ).toBe(false);
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
  });

  it("Given init selecting both packs, When it completes, Then their files are installed and check reports zero violations", async () => {
    const dir = await initializedRepo([
      "core",
      "creator",
      "verification",
      "changelog",
    ]);
    expect(
      await pathExists(join(dir, ".agents", "skills", "verify", "SKILL.md")),
    ).toBe(true);
    expect(
      await pathExists(join(dir, ".agents", "rules", "changelog.md")),
    ).toBe(true);
    expect(await pathExists(join(dir, "CHANGELOG.md"))).toBe(true);
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain(".agents/rules/verification.md");
    expect(agentsMd).toContain(".agents/rules/changelog.md");
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
    // full cycle: removing both packs leaves the repo just as clean
    await runPackRemove(dir, "verification", { force: false, dryRun: false });
    await runPackRemove(dir, "changelog", { force: false, dryRun: false });
    const after = await runCheck(dir);
    expect(after.violations).toEqual([]);
  });

  it("Given a non-TTY terminal, When the CLI runs pack add then pack remove with --json, Then both exit 0 with one machine object", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    const added = await runCli(dir, ["pack", "add", "verification", "--json"]);
    expect(added.code).toBe(0);
    const addReport = JSON.parse(added.stdout) as {
      command: string;
      exitCode: number;
    };
    expect(addReport.command).toBe("pack add");
    expect(addReport.exitCode).toBe(0);
    const removed = await runCli(dir, [
      "pack",
      "remove",
      "verification",
      "--json",
    ]);
    expect(removed.code).toBe(0);
    expect((JSON.parse(removed.stdout) as { command: string }).command).toBe(
      "pack remove",
    );
    expect(await pathExists(join(dir, ".agents", "skills", "verify"))).toBe(
      false,
    );
  });
});

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
