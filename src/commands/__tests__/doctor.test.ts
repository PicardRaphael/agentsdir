import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { GitSymlinksInfo, SymlinkSupport } from "../../core/detect.js";
import { readManifest } from "../../core/manifest.js";
import { cliPath, initAnswers, makeTempDir } from "../../test-support/index.js";
import { runDoctor, type DoctorFinding } from "../doctor.js";
import { runInit } from "../init.js";

const execFileAsync = promisify(execFile);

async function initializedRepo(): Promise<string> {
  const dir = await makeTempDir("doctor");
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

const SYMLINKS_OK: SymlinkSupport = {
  supported: true,
  reason: "a real symlink was created and verified",
};
const SYMLINKS_KO: SymlinkSupport = {
  supported: false,
  reason: "symlink creation failed (EPERM)",
};

function gitInfo(overrides: Partial<GitSymlinksInfo> = {}): GitSymlinksInfo {
  return {
    isGitRepo: true,
    coreSymlinks: "unset",
    materializedSymlinks: [],
    ...overrides,
  };
}

/** Fully injected probes: the diagnosis must not depend on the host machine. */
function probes(overrides: {
  symlinks?: SymlinkSupport;
  git?: GitSymlinksInfo;
}): Parameters<typeof runDoctor>[1] {
  return {
    symlinkSupport: () => Promise.resolve(overrides.symlinks ?? SYMLINKS_OK),
    gitSymlinks: () => Promise.resolve(overrides.git ?? gitInfo()),
    developerMode: () => Promise.resolve("not-applicable" as const),
    machineHarnesses: () => Promise.resolve([]),
  };
}

function finding(findings: DoctorFinding[], rule: string): DoctorFinding {
  const found = findings.find((entry) => entry.rule === rule);
  expect(found, `finding "${rule}" missing`).toBeDefined();
  return found as DoctorFinding;
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

describe("13 - doctor command", () => {
  it("Given an initialized repo, When doctor runs, Then it reports one state per line for every documented item and exits 0", async () => {
    const dir = await initializedRepo();
    const result = await runDoctor(dir, probes({}));
    expect(result.exitCode).toBe(0);
    const rules = result.findings.map((entry) => entry.rule);
    for (const rule of [
      "symlink-support",
      "git-core-symlinks",
      "windows-developer-mode",
      "projection-mode",
      "harnesses",
      "manifest-schema",
      "ci-workflow",
      "symlink-health",
      "gitattributes",
    ]) {
      expect(rules).toContain(rule);
    }
    expect(finding(result.findings, "manifest-schema").severity).toBe("ok");
    expect(finding(result.findings, "ci-workflow").severity).toBe("ok");
    expect(finding(result.findings, "gitattributes").severity).toBe("ok");
    expect(finding(result.findings, "harnesses").message).toContain(
      "enabled: claude, codex, cursor",
    );
  });

  it("Given copy mode and symlinks now available, When doctor runs, Then it proposes the switch without applying anything", async () => {
    const dir = await initializedRepo();
    const before = await readFile(join(dir, ".agents.toml"), "utf8");
    const result = await runDoctor(dir, probes({ symlinks: SYMLINKS_OK }));
    const mode = finding(result.findings, "projection-mode");
    expect(mode.severity).toBe("warn");
    expect(mode.message).toContain("sync --mode symlink");
    expect(await readFile(join(dir, ".agents.toml"), "utf8")).toBe(before);
    expect((await readManifest(dir)).projections.mode).toBe("copy");
    expect(result.exitCode).toBe(0);
  });

  it("Given copy mode with symlinks available but core.symlinks=false, When doctor runs, Then it does NOT propose the switch", async () => {
    const dir = await initializedRepo();
    const result = await runDoctor(
      dir,
      probes({
        symlinks: SYMLINKS_OK,
        git: gitInfo({ coreSymlinks: "false" }),
      }),
    );
    const mode = finding(result.findings, "projection-mode");
    expect(mode.severity).toBe("ok");
    expect(mode.message).not.toContain("sync --mode symlink");
  });

  it("Given symlink mode in an environment without symlink support, When doctor runs, Then it advises the copy switch and still exits 0", async () => {
    // initialize in copy mode, then flip the recorded mode by hand to
    // isolate the adequacy diagnosis from the machine's real capabilities
    const dir = await initializedRepo();
    const manifest = await readFile(join(dir, ".agents.toml"), "utf8");
    await writeFile(
      join(dir, ".agents.toml"),
      manifest.replace('mode = "copy"', 'mode = "symlink"'),
      "utf8",
    );
    const result = await runDoctor(dir, probes({ symlinks: SYMLINKS_KO }));
    const mode = finding(result.findings, "projection-mode");
    expect(mode.severity).toBe("error");
    expect(mode.message).toContain("sync --mode copy");
    expect(result.exitCode).toBe(0);
    const health = finding(result.findings, "symlink-health");
    expect(health.severity).toBe("ok");
  });

  it("Given symlinks indexed 120000 but materialized as text files, When doctor runs, Then the exact remedy is given and exit stays 0", async () => {
    const dir = await initializedRepo();
    const result = await runDoctor(
      dir,
      probes({
        git: gitInfo({
          coreSymlinks: "false",
          materializedSymlinks: ["CLAUDE.md", ".claude/rules"],
        }),
      }),
    );
    const health = finding(result.findings, "symlink-health");
    expect(health.severity).toBe("error");
    expect(health.message).toContain("git config core.symlinks true");
    expect(health.message).toContain("git checkout -- CLAUDE.md .claude/rules");
    expect(health.message).toContain("agentsdir sync --mode copy");
    expect(result.exitCode).toBe(0);
  });

  it("Given a repo that is not initialized, When doctor runs, Then it reports it as a finding and still exits 0", async () => {
    const dir = await makeTempDir("doctor");
    const result = await runDoctor(dir, probes({}));
    expect(result.exitCode).toBe(0);
    expect(result.mode).toBeNull();
    const manifest = finding(result.findings, "manifest");
    expect(manifest.severity).toBe("warn");
    expect(manifest.message).toContain("agentsdir init");
    expect(
      result.findings.some((entry) => entry.rule === "symlink-support"),
    ).toBe(true);
  });

  it("Given a manifest schema newer than the CLI, When doctor runs, Then the finding carries the upgrade message and exit stays 0", async () => {
    const dir = await initializedRepo();
    const manifest = await readFile(join(dir, ".agents.toml"), "utf8");
    await writeFile(
      join(dir, ".agents.toml"),
      manifest.replace("schema = 1", "schema = 99"),
      "utf8",
    );
    const result = await runDoctor(dir, probes({}));
    expect(result.exitCode).toBe(0);
    const found = finding(result.findings, "manifest");
    expect(found.severity).toBe("error");
    expect(found.message).toContain("newer than this CLI");
  });

  it("Given the CI workflow removed and .gitattributes without eol=lf, When doctor runs, Then both lines warn with their fix", async () => {
    const dir = await initializedRepo();
    await unlink(join(dir, ".github", "workflows", "agents-check.yml"));
    await writeFile(join(dir, ".gitattributes"), "*.png binary\n", "utf8");
    const result = await runDoctor(dir, probes({}));
    const workflow = finding(result.findings, "ci-workflow");
    expect(workflow.severity).toBe("warn");
    expect(workflow.message).toContain("agents-check.yml");
    const attributes = finding(result.findings, "gitattributes");
    expect(attributes.severity).toBe("warn");
    expect(attributes.message).toContain("eol=lf");
    expect(result.exitCode).toBe(0);
  });

  it("Given a repo full of anomalies, When doctor runs, Then it is strictly read-only", async () => {
    const dir = await initializedRepo();
    await unlink(join(dir, ".github", "workflows", "agents-check.yml"));
    await unlink(join(dir, ".gitattributes"));
    const before = await snapshotTree(dir);
    const result = await runDoctor(
      dir,
      probes({
        symlinks: SYMLINKS_KO,
        git: gitInfo({ materializedSymlinks: ["CLAUDE.md"] }),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it("Given the CLI, When doctor --json runs on a git repo, Then stdout is one machine object with every finding and exitCode 0", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    const { code, stdout } = await new Promise<{
      code: number;
      stdout: string;
    }>((resolve, reject) => {
      execFile(
        process.execPath,
        [cliPath, "doctor", "--json"],
        { cwd: dir },
        (error, out) => {
          if (error && typeof error.code !== "number") {
            reject(error);
            return;
          }
          resolve({
            code: typeof error?.code === "number" ? error.code : 0,
            stdout: out,
          });
        },
      );
    });
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      command: string;
      mode: string;
      changes: unknown[];
      errors: { rule: string; severity: string }[];
      exitCode: number;
    };
    expect(report.command).toBe("doctor");
    expect(report.mode).toBe("copy");
    expect(report.changes).toEqual([]);
    expect(report.errors.length).toBeGreaterThan(5);
    expect(report.exitCode).toBe(0);
  });
});
