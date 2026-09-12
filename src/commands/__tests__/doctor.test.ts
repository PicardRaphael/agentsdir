import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { GitSymlinksInfo, SymlinkSupport } from "../../core/detect.js";
import { readManifest } from "../../core/manifest.js";
import { defaultSkillAnswers } from "../../templates/skill.js";
import {
  cliPath,
  initAnswers,
  makeTempDir,
  runCli,
} from "../../test-support/index.js";
import { runAddSkill } from "../add-skill.js";
import { runCheck } from "../check.js";
import {
  renderDoctorReport,
  runDoctor,
  type DoctorFinding,
} from "../doctor.js";
import { runInit } from "../init.js";
import { runSync } from "../sync.js";

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
      manifest.replace(/schema = \d+/, "schema = 99"),
      "utf8",
    );
    const result = await runDoctor(dir, probes({}));
    expect(result.exitCode).toBe(0);
    const found = finding(result.findings, "manifest");
    expect(found.severity).toBe("error");
    expect(found.message).toContain("newer than this CLI");
  });

  it("Given a manifest schema older than the CLI, When doctor runs, Then it tells the user to run update rather than to wait for it", async () => {
    // the command exists now: a diagnosis naming it as unavailable sent the
    // reader looking for something they could not find
    const dir = await initializedRepo();
    const manifest = await readFile(join(dir, ".agents.toml"), "utf8");
    await writeFile(
      join(dir, ".agents.toml"),
      manifest.replace(/schema = \d+/, "schema = 1"),
      "utf8",
    );

    const found = finding(
      (await runDoctor(dir, probes({}))).findings,
      "manifest-schema",
    );

    expect(found.severity).toBe("warn");
    expect(found.message).toContain("`agentsdir update` to migrate it");
    expect(found.message).not.toContain("when available");
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

  it("Given an initialized repo, When doctor runs, Then the context budget separates what every session pays from the general total", async () => {
    const dir = await initializedRepo();
    await runAddSkill(dir, defaultSkillAnswers("demo-skill", false), {
      dryRun: false,
    });

    const result = await runDoctor(dir, probes({}));

    const budget = result.context;
    expect(budget).not.toBeNull();
    const always = budget?.totals.always;
    expect(always?.tokens).toBeGreaterThan(0);
    // AGENTS.md and the skill metadata, never the body of that skill
    expect(always?.tokens).toBeLessThan(budget?.totals.all.tokens ?? 0);
    expect(
      budget?.items.filter((entry) => entry.when === "on-invocation").length,
    ).toBeGreaterThan(0);
    const line = finding(result.findings, "context-budget");
    expect(line.severity).toBe("ok");
    // the two figures, each attached to what it counts: the summary line is
    // read on its own by whoever consumes `errors[]` and never sees the table
    expect(line.message).toContain(
      `~${always?.tokens} estimated tokens paid at every session`,
    );
    expect(line.message).toContain(
      `~${budget?.totals.all.tokens} across every moment of payment`,
    );
    expect(result.exitCode).toBe(0);

    const report = renderDoctorReport(result);
    // the nature of every figure, stated where the figures are read
    expect(report).toContain(
      "Bytes and lines are exact; tokens are an estimate",
    );
    expect(report).toContain("Paid at every session");
    expect(report).toContain("Paid on invocation");
    expect(report).toContain("Paid when relevant");
    expect(report).toContain("Total —");
  });

  it("Given more items than the terminal shows, When doctor runs, Then the heaviest are ranked first and --json still carries every one", async () => {
    const dir = await initializedRepo();
    // 14 skills of deliberately different sizes: more than one screenful, so
    // the ranking has to be right for the report to answer "what weighs most"
    for (let index = 0; index < 14; index += 1) {
      const name = `skill-${String(index).padStart(2, "0")}`;
      await mkdir(join(dir, ".agents", "skills", name), { recursive: true });
      await writeFile(
        join(dir, ".agents", "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Does ${name}.\n---\n\n# ${name}\n\n${"body ".repeat(20 * (index + 1))}\n`,
        "utf8",
      );
    }

    const result = await runDoctor(dir, probes({}));
    const bodies = (result.context?.items ?? []).filter(
      (entry) => entry.kind === "skill-body",
    );
    expect(bodies).toHaveLength(14);

    const report = renderDoctorReport(result);
    const shown = report
      .slice(report.indexOf("Paid on invocation"))
      .split("\n")
      .map((line) => /^\s+~(\d+)\s+\d+\s+\d+\s{2}(\S.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ tokens: Number(match[1]), element: match[2] }));

    // heaviest first, and the table stops before the lighter ones
    expect(shown).toHaveLength(12);
    expect([...shown].sort((a, b) => b.tokens - a.tokens)).toEqual(shown);
    expect(shown[0]?.element).toBe(".agents/skills/skill-13/SKILL.md (body)");
    expect(shown.map((row) => row.element)).not.toContain(
      ".agents/skills/skill-00/SKILL.md (body)",
    );
    expect(report).toContain("lighter item(s)");

    // truncated on screen, complete for a machine
    await execFileAsync("git", ["-C", dir, "init"]);
    const { stdout } = await runCli(dir, ["doctor", "--json"]);
    const machine = JSON.parse(stdout) as {
      context: { items: unknown[]; totals: { all: { items: number } } };
    };
    expect(machine.context.items).toHaveLength(
      machine.context.totals.all.items,
    );
    expect(machine.context.items.length).toBeGreaterThan(12);
  });

  it("Given a SKILL.md over the spec body budget, When doctor and check run, Then doctor signals it and check does not fail on it", async () => {
    const dir = await initializedRepo();
    await runAddSkill(dir, defaultSkillAnswers("heavy-skill", false), {
      dryRun: false,
    });
    const skill = join(dir, ".agents", "skills", "heavy-skill", "SKILL.md");
    // long lines, few of them: over ~5000 tokens while invariant 7, which
    // counts lines, sees nothing wrong
    await writeFile(
      skill,
      `${await readFile(skill, "utf8")}\n${`${"budget ".repeat(60)}\n`.repeat(60)}`,
      "utf8",
    );
    // the repository is otherwise in order: the projections follow the source
    await runSync(dir, { dryRun: false });

    const result = await runDoctor(dir, probes({}));

    const bounds = result.context?.bounds ?? [];
    expect(bounds.map((bound) => bound.rule)).toEqual(["skill-body-tokens"]);
    expect(bounds[0]?.path).toBe(".agents/skills/heavy-skill/SKILL.md");
    expect(finding(result.findings, "context-budget").severity).toBe("info");
    expect(result.exitCode).toBe(0);
    expect(renderDoctorReport(result)).toContain(
      "Agent Skills bounds exceeded",
    );

    // the budget informs; the drift guard is unmoved by it
    const check = await runCheck(dir);
    expect(check.exitCode).toBe(0);
    expect(
      check.violations.filter((violation) => violation.severity === "error"),
    ).toEqual([]);
    expect(
      check.violations.some((violation) => violation.rule.includes("budget")),
    ).toBe(false);
  });

  it("Given a repo that is not initialized, When doctor runs, Then there is no budget to report rather than an empty one", async () => {
    const dir = await makeTempDir("doctor");

    const result = await runDoctor(dir, probes({}));

    expect(result.context).toBeNull();
    expect(
      result.findings.some((entry) => entry.rule === "context-budget"),
    ).toBe(false);
    expect(renderDoctorReport(result)).not.toContain("Context budget");
  });

  it("Given the CLI, When doctor --json runs, Then the budget travels with the nature of its figures", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);

    const { stdout, code } = await runCli(dir, ["doctor", "--json"]);

    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      context: {
        units: { bytes: string; lines: string; tokens: string };
        tokenEstimate: { charsPerToken: number; calibration: string };
        bounds: {
          maxDescriptionChars: number;
          maxBodyTokens: number;
          exceeded: unknown[];
        };
        totals: {
          always: { tokens: number };
          all: { items: number; tokens: number };
        };
        items: { path: string; kind: string; when: string; tokens: number }[];
      };
    };
    expect(report.context.units).toEqual({
      bytes: "exact, UTF-8",
      lines: "exact",
      tokens: "estimate",
    });
    expect(report.context.tokenEstimate.charsPerToken).toBe(4);
    expect(report.context.tokenEstimate.calibration).toContain("o200k_base");
    expect(report.context.bounds.maxDescriptionChars).toBe(1024);
    expect(report.context.bounds.maxBodyTokens).toBe(5000);
    expect(report.context.bounds.exceeded).toEqual([]);
    // every item travels, whatever the terminal chose to show of them
    expect(report.context.items.length).toBe(report.context.totals.all.items);
    expect(report.context.items.map((entry) => entry.path)).toContain(
      "AGENTS.md",
    );
    expect(report.context.totals.always.tokens).toBeLessThanOrEqual(
      report.context.totals.all.tokens,
    );
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
