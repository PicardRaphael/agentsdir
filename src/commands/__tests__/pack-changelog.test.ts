import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../core/errors.js";
import { readManifest } from "../../core/manifest.js";
import { runCheck } from "../check.js";
import { runInit, type InitAnswers } from "../init.js";
import { runPackAdd, runPackRemove } from "../pack.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentsdir-pack-changelog-"));
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

function initAnswers(): InitAnswers {
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
  await runInit(dir, initAnswers(), { dryRun: false });
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

describe("11 - pack changelog", () => {
  it("Given an initialized repo, When pack add changelog runs, Then the rule and the CHANGELOG.md seed are installed and indexed, and check stays clean", async () => {
    const dir = await initializedRepo();
    const result = await runPackAdd(dir, "changelog", { dryRun: false });
    expect(result.exitCode).toBe(0);
    const rule = await readFile(
      join(dir, ".agents", "rules", "changelog.md"),
      "utf8",
    );
    expect(rule.startsWith("# Changelog\n")).toBe(true);
    expect(rule).toContain("ALWAYS");
    expect(rule).toContain("GOOD:");
    const changelog = await readFile(join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("## [Unreleased]");
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain(".agents/rules/changelog.md");
    const manifest = await readManifest(dir);
    expect(manifest.packs.installed).toContain("changelog");
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
  });

  it("Given an existing CHANGELOG.md, When pack add changelog runs, Then the file is kept as is with a note", async () => {
    const dir = await initializedRepo();
    const existing = "# Changelog\n\nMy own history.\n";
    await writeFile(join(dir, "CHANGELOG.md"), existing, "utf8");
    const result = await runPackAdd(dir, "changelog", { dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(dir, "CHANGELOG.md"), "utf8")).toBe(existing);
    expect(result.notes.some((note) => note.includes("CHANGELOG.md"))).toBe(
      true,
    );
  });

  it("Given a CHANGELOG.md that differs from the seed, When pack remove changelog runs, Then it exits 1 removing nothing without --force", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "changelog", { dryRun: false });
    await writeFile(
      join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A real entry.\n",
      "utf8",
    );
    let error: unknown;
    try {
      await runPackRemove(dir, "changelog", { force: false, dryRun: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect(await pathExists(join(dir, "CHANGELOG.md"))).toBe(true);
    expect(
      await pathExists(join(dir, ".agents", "rules", "changelog.md")),
    ).toBe(true);
  });

  it("Given the pack installed and untouched, When pack remove changelog runs, Then rule, CHANGELOG.md and index line are removed", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "changelog", { dryRun: false });
    const result = await runPackRemove(dir, "changelog", {
      force: false,
      dryRun: false,
    });
    expect(result.exitCode).toBe(0);
    expect(await pathExists(join(dir, "CHANGELOG.md"))).toBe(false);
    expect(
      await pathExists(join(dir, ".agents", "rules", "changelog.md")),
    ).toBe(false);
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain(".agents/rules/changelog.md");
    const manifest = await readManifest(dir);
    expect(manifest.packs.installed).not.toContain("changelog");
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
  });
});
