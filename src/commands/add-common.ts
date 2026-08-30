import * as prompts from "@clack/prompts";
import { asUserFacingError, CliError } from "../core/errors.js";
import {
  writeManifest,
  type Manifest,
  type ProjectionMode,
} from "../core/manifest.js";
import { refreshProjections } from "../core/projections.js";
import { NAME_SPEC } from "../core/validate.js";
import { EXIT_CODES, type ExitCode } from "../exit-codes.js";

/**
 * Shared plumbing of the three generators (`add skill|rule|agent`): name
 * validation, interactive helpers, report and the CLI wrapper with the same
 * `--json` contract as `check` and `sync`.
 */
export interface GeneratorChange {
  /** Repo-relative path, always with forward slashes. */
  path: string;
  action: "created" | "updated" | "removed";
}

export interface GeneratorResult {
  changes: GeneratorChange[];
  exitCode: ExitCode;
  mode: ProjectionMode;
}

/**
 * Refreshes the Claude Code projections after a generator wrote to the source
 * of truth, so a created skill or rule is visible right away in copy mode as
 * it already is in symlink mode — and `check` stays green without a manual
 * `sync`. Deliberately narrower than `sync`: no full `validateRepo`, so a
 * generator never fails on the state of unrelated content.
 */
export async function resyncProjections(
  root: string,
  manifest: Manifest,
  options: {
    dryRun: boolean;
    /**
     * Content of the source files the generator is about to write, so a dry
     * run plans the same projections as the run that writes them first.
     */
    overlay?: Record<string, string>;
  },
): Promise<GeneratorChange[]> {
  if (!manifest.harness.enabled.includes("claude")) {
    return [];
  }
  const mode = manifest.projections.mode;
  const overlay: Record<string, Buffer> = {};
  for (const [path, content] of Object.entries(options.overlay ?? {})) {
    overlay[path] = Buffer.from(content, "utf8");
  }
  const projection = await refreshProjections(root, {
    mode,
    // a generator never switches mode: that is `sync --mode`
    previousMode: mode,
    previousHashes: manifest.projections.hashes,
    overlay,
    dryRun: options.dryRun,
  });
  const changes: GeneratorChange[] = projection.removed.map((path) => ({
    path,
    action: "removed" as const,
  }));
  for (const change of projection.changes) {
    if (change.action === "unchanged") {
      continue;
    }
    changes.push({
      path: change.path,
      action: change.existed ? "updated" : "created",
    });
  }
  if (!options.dryRun) {
    await writeManifest(root, {
      ...manifest,
      projections: { mode, hashes: projection.hashes },
    });
  }
  // sorted so a dry run and the real run report the same order, whether the
  // sources came from the overlay or from disk
  return changes.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/** Usage error (exit 2) when the name is not kebab-case per the Agent Skills spec. */
export function ensureValidName(kind: string, name: string): void {
  if (!NAME_SPEC.test(name)) {
    throw new CliError(
      `Invalid ${kind} name "${name}" — use kebab-case: 1 to 64 characters of a-z, 0-9 and -, without a leading or trailing dash.`,
    );
  }
}

/** Generators only ask questions on a real terminal; scripts get the defaults. */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Unwraps a @clack/prompts answer; a cancelled prompt aborts the command. */
export function ensureAnswer<T>(value: T | symbol, command: string): T {
  if (prompts.isCancel(value)) {
    prompts.cancel(`${command} cancelled.`);
    throw new CliError(`${command} cancelled.`);
  }
  return value as T;
}

export function renderGeneratorReport(
  result: GeneratorResult,
  options: { dryRun: boolean },
): string {
  const lines: string[] = [];
  lines.push(
    options.dryRun ? "Dry run — nothing was written. Full plan:" : "Done:",
  );
  for (const change of result.changes) {
    lines.push(`  ${change.action.padEnd(7)}  ${change.path}`);
  }
  return lines.join("\n");
}

/**
 * Runs a generator body and renders its outcome — human report or the
 * machine object `{command, mode, changes, errors, exitCode}` with `--json`.
 */
export async function runGeneratorCli(
  command: string,
  json: boolean,
  body: () => Promise<{ result: GeneratorResult; report: string }>,
): Promise<void> {
  try {
    const { result, report } = await body();
    if (json) {
      console.log(
        JSON.stringify({
          command,
          mode: result.mode,
          changes: result.changes,
          errors: [],
          exitCode: result.exitCode,
        }),
      );
    } else {
      console.log(report);
    }
    process.exitCode = result.exitCode;
  } catch (rawError) {
    const error = asUserFacingError(rawError);
    if (error !== undefined) {
      if (json) {
        console.log(
          JSON.stringify({
            command,
            mode: null,
            changes: [],
            errors: [
              {
                path: "",
                rule:
                  error.exitCode === EXIT_CODES.environmentOrUsage
                    ? "environment"
                    : "invariant",
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
}
