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
          : `manifest schema ${manifest.schema} is older than this CLI (schema ${MANIFEST_SCHEMA}) — run \`agentsdir update\` when available.`,
    });
  }
  findings.push(await workflowFinding(root));
  if (git.isGitRepo) {
    findings.push(symlinkHealthFinding(git));
  }
  findings.push(await gitattributesFinding(root));
  return { findings, mode, exitCode: EXIT_CODES.ok };
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
  return lines.join("\n");
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
