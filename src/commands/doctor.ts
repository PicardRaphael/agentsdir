import { isFile } from "../core/fs-utils.js";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { defineCommand } from "citty";
import {
  detectGitSymlinks,
  detectHarnesses,
  detectSymlinkSupport,
  type GitSymlinksInfo,
  type SymlinkSupport,
} from "../core/detect.js";
import {
  CHARS_PER_TOKEN,
  MAX_BODY_TOKENS,
  MAX_DESCRIPTION_CHARS,
  measureContextBudget,
  type BudgetItem,
  type ContextBudget,
  type WhenPaid,
} from "../core/context-budget.js";
import { asUserFacingError } from "../core/errors.js";
import {
  MANIFEST_SCHEMA,
  ManifestError,
  readManifest,
  type Manifest,
  type ProjectionMode,
} from "../core/manifest.js";
import { resolveRepoRoot } from "../core/repo.js";
import { EXIT_CODES, type ExitCode } from "../exit-codes.js";

const execFileAsync = promisify(execFile);

export type DoctorSeverity = "ok" | "info" | "warn" | "error";

export interface DoctorFinding {
  rule: string;
  message: string;
  severity: DoctorSeverity;
}

export type DeveloperMode =
  "enabled" | "disabled" | "unknown" | "not-applicable";

/**
 * Environment probes, injectable so the diagnosis is testable on any machine
 * (real symlink support, registry state and PATH content vary per host).
 */
export interface DoctorProbes {
  symlinkSupport: () => Promise<SymlinkSupport>;
  gitSymlinks: () => Promise<GitSymlinksInfo>;
  developerMode: () => Promise<DeveloperMode>;
  machineHarnesses: () => Promise<string[]>;
}

export interface DoctorResult {
  findings: DoctorFinding[];
  mode: ProjectionMode | null;
  /**
   * What the installed configuration costs in context, or `null` when there is
   * nothing installed to measure.
   */
  context: ContextBudget | null;
  /** Always 0: doctor diagnoses, `check` carries the CI failure. */
  exitCode: ExitCode;
}

/**
 * Strictly read-only diagnosis of the machine and the clone — one state per
 * line, each non-ok line naming its exact fix. Exit 0 even with problems.
 */
export async function runDoctor(
  root: string,
  overrides: Partial<DoctorProbes> = {},
): Promise<DoctorResult> {
  const probes: DoctorProbes = {
    symlinkSupport: () => detectSymlinkSupport(root),
    gitSymlinks: () => detectGitSymlinks(root),
    developerMode: () => detectWindowsDeveloperMode(),
    machineHarnesses: () => detectHarnessesOnPath(),
    ...overrides,
  };
  const findings: DoctorFinding[] = [];
  const support = await probes.symlinkSupport();
  const git = await probes.gitSymlinks();
  findings.push({
    rule: "symlink-support",
    severity: support.supported ? "ok" : "info",
    message: support.supported
      ? `real symlinks work here — ${support.reason}.`
      : `real symlinks are not available — ${support.reason}.`,
  });
  findings.push({
    rule: "git-core-symlinks",
    severity: git.coreSymlinks === "false" ? "info" : "ok",
    message:
      git.coreSymlinks === "false"
        ? "git config core.symlinks is false — git indexes links as regular files; run `git config core.symlinks true` if this machine supports symlinks."
        : `git config core.symlinks is ${git.coreSymlinks}.`,
  });
  const developerMode = await probes.developerMode();
  findings.push({
    rule: "windows-developer-mode",
    severity: developerMode === "disabled" ? "info" : "ok",
    message:
      developerMode === "not-applicable"
        ? `not applicable on ${process.platform}.`
        : developerMode === "enabled"
          ? "Windows Developer Mode is enabled — symlinks work without elevation."
          : developerMode === "disabled"
            ? "Windows Developer Mode is disabled — enable it (Settings > For developers) or run elevated to create symlinks."
            : "Windows Developer Mode state could not be read (best effort).",
  });
  let manifest: Manifest | undefined;
  try {
    manifest = await readManifest(root);
  } catch (error) {
    if (!(error instanceof ManifestError)) {
      throw error;
    }
    const missing = error.message.includes("not found");
    findings.push({
      rule: "manifest",
      severity: missing ? "warn" : "error",
      message: missing
        ? "not initialized — run `agentsdir init` to install the architecture."
        : error.message,
    });
  }
  const mode = manifest?.projections.mode ?? null;
  if (manifest !== undefined) {
    findings.push(modeAdequacy(manifest.projections.mode, support, git));
  }
  findings.push(
    await harnessesFinding(root, manifest, await probes.machineHarnesses()),
  );
  if (manifest !== undefined) {
    findings.push({
      rule: "manifest-schema",
      severity: manifest.schema === MANIFEST_SCHEMA ? "ok" : "warn",
      message:
        manifest.schema === MANIFEST_SCHEMA
          ? `manifest schema ${manifest.schema} matches this CLI (schema ${MANIFEST_SCHEMA}).`
          : `manifest schema ${manifest.schema} is older than this CLI (schema ${MANIFEST_SCHEMA}) — run \`agentsdir update\` to migrate it.`,
    });
  }
  findings.push(await workflowFinding(root));
  if (git.isGitRepo) {
    findings.push(symlinkHealthFinding(git));
  }
  findings.push(await gitattributesFinding(root));
  const budget = await measureContextBudget(root);
  const context = budget.items.length === 0 ? null : budget;
  if (context !== null) {
    findings.push(contextBudgetFinding(context));
  }
  return { findings, mode, context, exitCode: EXIT_CODES.ok };
}

/**
 * The budget in one doctor line, for the readers of `errors[]` alone. It says
 * what is paid at every session before what is paid in total, and never fails:
 * a budget overrun is information, `check` stays the guardian of drift.
 */
function contextBudgetFinding(budget: ContextBudget): DoctorFinding {
  const { always, all } = budget.totals;
  const head = `~${always.tokens} estimated tokens paid at every session (${always.items} of ${all.items} items), ~${all.tokens} across every moment of payment.`;
  return {
    rule: "context-budget",
    severity: budget.bounds.length === 0 ? "ok" : "info",
    message:
      budget.bounds.length === 0
        ? `${head} No Agent Skills bound exceeded.`
        : `${head} ${budget.bounds.length} Agent Skills bound(s) exceeded — listed in the context budget below; informational, \`check\` does not fail on them.`,
  };
}

/**
 * The heart of the diagnosis: does the recorded projection mode still fit the
 * environment? Four explicit cases — never applied, only advised.
 */
function modeAdequacy(
  mode: ProjectionMode,
  support: SymlinkSupport,
  git: GitSymlinksInfo,
): DoctorFinding {
  if (mode === "symlink" && !support.supported) {
    return {
      rule: "projection-mode",
      severity: "error",
      message: `manifest mode is "symlink" but this environment cannot create real symlinks (${support.reason}) — switch modes with \`agentsdir sync --mode copy\`.`,
    };
  }
  if (mode === "symlink" && git.coreSymlinks === "false") {
    return {
      rule: "projection-mode",
      severity: "error",
      message:
        'manifest mode is "symlink" but git config core.symlinks is false: git would index the links as regular files — run `git config core.symlinks true`, or switch modes with `agentsdir sync --mode copy`.',
    };
  }
  if (mode === "copy" && support.supported && git.coreSymlinks !== "false") {
    return {
      rule: "projection-mode",
      severity: "warn",
      message:
        'manifest mode is "copy" and symlinks are now available — run `agentsdir sync --mode symlink` to switch (doctor changes nothing itself).',
    };
  }
  return {
    rule: "projection-mode",
    severity: "ok",
    message: `manifest mode "${mode}" fits this environment.`,
  };
}

/**
 * The documented pathological case: paths indexed as symlinks (git mode
 * 120000) but materialized as regular text files by a checkout done without
 * core.symlinks — with the exact remedy.
 */
function symlinkHealthFinding(git: GitSymlinksInfo): DoctorFinding {
  if (git.materializedSymlinks.length === 0) {
    return {
      rule: "symlink-health",
      severity: "ok",
      message: "no symlink materialized as a text file.",
    };
  }
  const paths = git.materializedSymlinks.join(" ");
  return {
    rule: "symlink-health",
    severity: "error",
    message: `indexed as symlinks (git mode 120000) but materialized as regular text files: ${paths} — run \`git config core.symlinks true\` then \`git checkout -- ${paths}\` to restore real links, or switch modes with \`agentsdir sync --mode copy\`.`,
  };
}

async function harnessesFinding(
  root: string,
  manifest: Manifest | undefined,
  onPath: string[],
): Promise<DoctorFinding> {
  const material = await detectHarnesses(root);
  const inRepo: string[] = [];
  if (material.claudeDir || material.claudeMd) {
    inRepo.push("claude");
  }
  if (material.codexDir) {
    inRepo.push("codex");
  }
  if (material.cursorDir) {
    inRepo.push("cursor");
  }
  const enabled = manifest?.harness.enabled ?? [];
  const invisible = enabled.filter(
    (harness) => !inRepo.includes(harness) && !onPath.includes(harness),
  );
  const describe = (list: string[]): string =>
    list.length === 0 ? "none" : list.join(", ");
  return {
    rule: "harnesses",
    severity: invisible.length === 0 ? "ok" : "info",
    message:
      `enabled: ${describe(enabled)}; detected in repo: ${describe(inRepo)}; found on PATH: ${describe(onPath)}.` +
      (invisible.length === 0
        ? ""
        : ` ${invisible.join(", ")} enabled but detected nowhere — projections are still generated; remove it from [harness] enabled in .agents.toml if unused.`),
  };
}

async function workflowFinding(root: string): Promise<DoctorFinding> {
  const path = ".github/workflows/agents-check.yml";
  const present = await isFile(join(root, ...path.split("/")));
  return {
    rule: "ci-workflow",
    severity: present ? "ok" : "warn",
    message: present
      ? `${path} present — check runs in CI.`
      : `${path} missing — nothing runs \`agentsdir check\` in CI; restore it from git history or from a fresh \`agentsdir init\`.`,
  };
}

async function gitattributesFinding(root: string): Promise<DoctorFinding> {
  let content = "";
  try {
    content = await readFile(join(root, ".gitattributes"), "utf8");
  } catch {
    // absent: reported below
  }
  const normalized = content.includes("eol=lf");
  return {
    rule: "gitattributes",
    severity: normalized ? "ok" : "warn",
    message: normalized
      ? ".gitattributes forces eol=lf — fingerprinted files are identical on every machine."
      : ".gitattributes does not force eol=lf — line endings may differ between machines and break fingerprints; add `* text=auto eol=lf`.",
  };
}

/** Best-effort Windows Developer Mode detection (registry read). */
async function detectWindowsDeveloperMode(): Promise<DeveloperMode> {
  if (process.platform !== "win32") {
    return "not-applicable";
  }
  try {
    const { stdout } = await execFileAsync("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock",
      "/v",
      "AllowDevelopmentWithoutDevLicense",
    ]);
    return /0x1\b/.test(stdout) ? "enabled" : "disabled";
  } catch {
    return "unknown";
  }
}

/** Pure PATH scan (no process spawned) for the harness CLIs. */
async function detectHarnessesOnPath(): Promise<string[]> {
  const dirs = (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "");
  const extensions =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const found: string[] = [];
  for (const binary of ["claude", "codex", "cursor"]) {
    scan: for (const dir of dirs) {
      for (const extension of extensions) {
        if (await isFile(join(dir, `${binary}${extension}`))) {
          found.push(binary);
          break scan;
        }
      }
    }
  }
  return found;
}

export function renderDoctorReport(result: DoctorResult): string {
  const lines: string[] = [
    "Doctor report — diagnosis only; `agentsdir check` carries the CI failure.",
  ];
  for (const finding of result.findings) {
    lines.push(
      `  ${finding.severity.padEnd(5)}  ${finding.rule} · ${finding.message}`,
    );
  }
  const count = (severity: DoctorSeverity): number =>
    result.findings.filter((finding) => finding.severity === severity).length;
  lines.push("");
  lines.push(
    `Summary: ${count("ok")} ok, ${count("info")} info, ${count("warn")} warning(s), ${count("error")} error(s) — every non-ok line names its fix.`,
  );
  if (result.context !== null) {
    lines.push("");
    lines.push(renderContextBudget(result.context));
  }
  return lines.join("\n");
}

/** Heading of each bucket, in payment order: always first, it is the one that compounds. */
const BUCKETS: { when: WhenPaid; title: string; explanation: string }[] = [
  {
    when: "always",
    title: "Paid at every session",
    explanation: "AGENTS.md, skill and sub-agent metadata, unscoped rules",
  },
  {
    when: "on-invocation",
    title: "Paid on invocation",
    explanation: "a skill or sub-agent body, and the references it reads",
  },
  {
    when: "when-relevant",
    title: "Paid when relevant",
    explanation: "a scoped rule, when the session touches a file it covers",
  },
];

/** How many items of one bucket the terminal shows; `--json` always carries them all. */
const SHOWN_PER_BUCKET = 12;

/**
 * The budget as a human reads it: one block per moment of payment, heaviest
 * first inside each, and the nature of every number stated once at the top —
 * a figure whose unit is unknown is worse than no figure.
 */
export function renderContextBudget(budget: ContextBudget): string {
  const lines: string[] = [
    "Context budget — what this configuration costs in context.",
    `Bytes and lines are exact; tokens are an estimate (~), one per ${CHARS_PER_TOKEN} characters, calibrated once — see docs/conventions.md §10.`,
  ];
  for (const bucket of BUCKETS) {
    const items = budget.items
      .filter((item) => item.when === bucket.when)
      .sort((a, b) => b.tokens - a.tokens || compareLabel(a, b));
    const totals = sumOf(items);
    lines.push("");
    lines.push(
      `  ${bucket.title} — ~${totals.tokens} tokens, ${totals.bytes} bytes, ${items.length} item(s) (${bucket.explanation})`,
    );
    if (items.length === 0) {
      lines.push("    none");
      continue;
    }
    lines.push(...renderItemTable(items.slice(0, SHOWN_PER_BUCKET)));
    if (items.length > SHOWN_PER_BUCKET) {
      lines.push(
        `    ... and ${items.length - SHOWN_PER_BUCKET} lighter item(s); \`agentsdir doctor --json\` lists every one.`,
      );
    }
  }
  lines.push("");
  lines.push(
    `  Total — ~${budget.totals.all.tokens} tokens, ${budget.totals.all.bytes} bytes, ${budget.totals.all.items} item(s); a session pays the "every session" block above, never this total.`,
  );
  lines.push("");
  if (budget.bounds.length === 0) {
    lines.push(
      `  Agent Skills bounds — none exceeded (description up to ${MAX_DESCRIPTION_CHARS} characters, body up to ~${MAX_BODY_TOKENS} tokens).`,
    );
  } else {
    lines.push(
      "  Agent Skills bounds exceeded — informational; `agentsdir check` does not fail on a budget.",
    );
    for (const bound of budget.bounds) {
      lines.push(`    ${bound.path} · ${bound.message}`);
    }
  }
  return lines.join("\n");
}

function renderItemTable(items: BudgetItem[]): string[] {
  const rows = items.map((item) => ({
    tokens: `~${item.tokens}`,
    bytes: String(item.bytes),
    lines: String(item.lines),
    element: labelOf(item),
  }));
  const width = (pick: (row: (typeof rows)[number]) => string, head: string) =>
    Math.max(head.length, ...rows.map((row) => pick(row).length));
  const tokensWidth = width((row) => row.tokens, "tokens");
  const bytesWidth = width((row) => row.bytes, "bytes");
  const linesWidth = width((row) => row.lines, "lines");
  const header = `    ${"tokens".padStart(tokensWidth)}  ${"bytes".padStart(bytesWidth)}  ${"lines".padStart(linesWidth)}  element`;
  return [
    header,
    ...rows.map(
      (row) =>
        `    ${row.tokens.padStart(tokensWidth)}  ${row.bytes.padStart(bytesWidth)}  ${row.lines.padStart(linesWidth)}  ${row.element}`,
    ),
  ];
}

/** The path, plus what part of it this item is when a file is paid in two moments. */
function labelOf(item: BudgetItem): string {
  switch (item.kind) {
    case "skill-metadata":
    case "agent-metadata":
      return `${item.path} (metadata)`;
    case "skill-body":
    case "agent-body":
      return `${item.path} (body)`;
    default:
      return item.path;
  }
}

function compareLabel(a: BudgetItem, b: BudgetItem): number {
  const left = labelOf(a);
  const right = labelOf(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The budget for a script. It carries the nature of each number beside the
 * numbers: a consumer tracking the budget over time must never have to guess
 * whether `tokens` was counted or estimated, nor with which divisor.
 */
function machineContext(budget: ContextBudget | null): unknown {
  if (budget === null) {
    return null;
  }
  return {
    units: {
      bytes: "exact, UTF-8",
      lines: "exact",
      tokens: "estimate",
    },
    tokenEstimate: {
      charsPerToken: CHARS_PER_TOKEN,
      calibration:
        "2026-09-12, o200k_base BPE over 33 Markdown files: 4.03 characters per token observed; see docs/conventions.md §10",
    },
    bounds: {
      maxDescriptionChars: MAX_DESCRIPTION_CHARS,
      maxBodyTokens: MAX_BODY_TOKENS,
      exceeded: budget.bounds,
    },
    totals: budget.totals,
    items: budget.items,
  };
}

function sumOf(items: BudgetItem[]): { bytes: number; tokens: number } {
  return {
    bytes: items.reduce((total, item) => total + item.bytes, 0),
    tokens: items.reduce((total, item) => total + item.tokens, 0),
  };
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description:
      "Diagnose the machine and the clone (read-only; exit 0 even with problems)",
  },
  args: {
    json: {
      type: "boolean",
      description: "Machine output: a single JSON object on stdout",
    },
  },
  async run({ args }) {
    const json = args.json === true;
    try {
      const root = await resolveRepoRoot(process.cwd());
      const result = await runDoctor(root);
      if (json) {
        console.log(
          JSON.stringify({
            command: "doctor",
            mode: result.mode,
            changes: [],
            errors: result.findings,
            context: machineContext(result.context),
            exitCode: result.exitCode,
          }),
        );
      } else {
        console.log(renderDoctorReport(result));
      }
      process.exitCode = result.exitCode;
    } catch (rawError) {
      const error = asUserFacingError(rawError);
      if (error !== undefined) {
        if (json) {
          console.log(
            JSON.stringify({
              command: "doctor",
              mode: null,
              changes: [],
              errors: [
                {
                  rule: "environment",
                  message: error.message,
                  severity: "error",
                },
              ],
              // the key is always there, so a script that tracks the budget
              // over time reads one shape whether the run succeeded or not
              context: null,
              exitCode: error.exitCode,
            }),
          );
        } else {
          console.error(error.message);
        }
        process.exitCode = error.exitCode;
        return;
      }
      throw rawError;
    }
  },
});
