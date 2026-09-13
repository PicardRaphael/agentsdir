import { describe, expect, it } from "vitest";
import type { GitSymlinksInfo, SymlinkSupport } from "../../core/detect.js";
import { MAX_DESCRIPTION_CHARS } from "../../core/context-budget.js";
import {
  CONVENTIONS_CONSULTED,
  STALE_AFTER_MONTHS,
} from "../../core/conventions-dates.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { CLI_RELEASED, CLI_VERSION } from "../../version.js";
import { runCheck } from "../check.js";
import {
  renderContextBudget,
  renderDoctorReport,
  runDoctor,
  type DoctorFinding,
} from "../doctor.js";
import { runInit } from "../init.js";
import { runSync } from "../sync.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SYMLINKS_OK: SymlinkSupport = { supported: true, reason: "injected" };
const GIT: GitSymlinksInfo = {
  isGitRepo: true,
  coreSymlinks: "unset",
  materializedSymlinks: [],
};

/** Injected probes, clock included: an age must not depend on the day the suite runs. */
function probes(today: string): Parameters<typeof runDoctor>[1] {
  return {
    symlinkSupport: () => Promise.resolve(SYMLINKS_OK),
    gitSymlinks: () => Promise.resolve(GIT),
    developerMode: () => Promise.resolve("not-applicable" as const),
    machineHarnesses: () => Promise.resolve([]),
    today: () => new Date(`${today}T00:00:00Z`),
  };
}

function finding(findings: DoctorFinding[], rule: string): DoctorFinding {
  const found = findings.find((entry) => entry.rule === rule);
  expect(found, `finding "${rule}" missing`).toBeDefined();
  return found as DoctorFinding;
}

async function initializedRepo(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

/**
 * Criterion: "doctor displays the publication date of the CLI and the date of
 * the conventions it embeds, with an explicit notice when that gap exceeds six
 * months."
 */
describe("Given a repository and a CLI of a known vintage", () => {
  it("When doctor runs on the day the CLI was cut, Then both dates are reported and neither raises a notice", async () => {
    const dir = await initializedRepo("doctor-age-fresh");
    const { findings } = await runDoctor(dir, probes(CLI_RELEASED));
    const cli = finding(findings, "cli-age");
    expect(cli.severity).toBe("ok");
    expect(cli.message).toContain(CLI_VERSION);
    expect(cli.message).toContain(CLI_RELEASED);
    const conventions = finding(findings, "conventions-age");
    expect(conventions.severity).toBe("ok");
    expect(conventions.message).toContain(CONVENTIONS_CONSULTED);
  });

  it("When exactly six months have passed, Then the dates are still reported without a notice", async () => {
    const dir = await initializedRepo("doctor-age-six");
    const sixMonths = shift(CLI_RELEASED, STALE_AFTER_MONTHS);
    const { findings } = await runDoctor(dir, probes(sixMonths));
    expect(finding(findings, "cli-age").severity).toBe("ok");
    expect(finding(findings, "cli-age").message).toContain(
      `${STALE_AFTER_MONTHS} month(s) ago`,
    );
  });

  it("When the gap exceeds six months, Then the notice is explicit and names both the age and the remedy", async () => {
    const dir = await initializedRepo("doctor-age-stale");
    const late = shift(CLI_RELEASED, STALE_AFTER_MONTHS + 3);
    const { findings } = await runDoctor(dir, probes(late));
    const cli = finding(findings, "cli-age");
    expect(cli.severity).toBe("warn");
    expect(cli.message).toContain("9 months ago");
    expect(cli.message).toContain(`past ${STALE_AFTER_MONTHS}`);
    expect(cli.message).toContain("newer agentsdir");
    const conventions = finding(findings, "conventions-age");
    expect(conventions.severity).toBe("warn");
    expect(conventions.message).toContain(CONVENTIONS_CONSULTED);
    expect(conventions.message).toContain("docs/conventions.md");
  });

  it("When the report is rendered, Then both dates are on the page before anything they support", async () => {
    const dir = await initializedRepo("doctor-age-report");
    const result = await runDoctor(dir, probes(CLI_RELEASED));
    const lines = renderDoctorReport(result).split("\n");
    const cli = lines.findIndex((line) => line.includes("cli-age"));
    const conventions = lines.findIndex((line) =>
      line.includes("conventions-age"),
    );
    const budget = lines.findIndex((line) => line.includes("context-budget"));
    expect(cli).toBeGreaterThan(0);
    expect(conventions).toBe(cli + 1);
    expect(conventions).toBeLessThan(budget);
  });
});

/**
 * Criterion: the four diagnostics stay apart — a form no longer recommended is
 * reported by `doctor`, and `check` stays green on it.
 */
describe("Given a skill whose description exceeds the spec bound", () => {
  it("When doctor runs, Then it reports the bound with the source and the day it was read", async () => {
    const dir = await initializedRepo("doctor-bound-source");
    await writeOverlongSkill(dir);
    await runSync(dir, { dryRun: false });
    const result = await runDoctor(dir, probes(CLI_RELEASED));
    expect(result.context).not.toBeNull();
    expect(result.context?.bounds.map((bound) => bound.rule)).toEqual([
      "skill-description-length",
    ]);
    const rendered = renderContextBudget(
      result.context ?? { items: [], bounds: [], totals: emptyTotals() },
    );
    expect(rendered).toContain("agentskills.io");
    expect(rendered).toContain(`read ${CONVENTIONS_CONSULTED}`);
  });

  it("When check runs on the same repository, Then it stays green: a form is not a drift", async () => {
    const dir = await initializedRepo("doctor-bound-check");
    await writeOverlongSkill(dir);
    await runSync(dir, { dryRun: false });
    const result = await runCheck(dir);
    expect(result.exitCode).toBe(0);
    expect(
      result.violations.filter((violation) => violation.severity === "error"),
    ).toEqual([]);
  });
});

async function writeOverlongSkill(dir: string): Promise<void> {
  const folder = join(dir, ".agents", "skills", "overlong");
  await mkdir(folder, { recursive: true });
  const description = "x".repeat(MAX_DESCRIPTION_CHARS + 1);
  await writeFile(
    join(folder, "SKILL.md"),
    [
      "---",
      "name: overlong",
      `description: "${description}"`,
      "---",
      "",
      "# Overlong",
      "",
      ...Array.from(
        { length: 14 },
        (_, index) => `- Step ${index + 1} of a procedure long enough to pass.`,
      ),
      "",
    ].join("\n"),
    "utf8",
  );
}

function emptyTotals() {
  const zero = { items: 0, bytes: 0, tokens: 0 };
  return { always: zero, onInvocation: zero, whenRelevant: zero, all: zero };
}

/** The same calendar day, `months` later — the antedating the verification asks for. */
function shift(iso: string, months: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}
