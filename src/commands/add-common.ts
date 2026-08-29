import * as prompts from "@clack/prompts";
import { CliError } from "../core/errors.js";
import type { ProjectionMode } from "../core/manifest.js";
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
  action: "created" | "updated";
}

export interface GeneratorResult {
  changes: GeneratorChange[];
  exitCode: ExitCode;
  mode: ProjectionMode;
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
    options.dryRun
      ? "Dry run — nothing was written. Planned writes:"
      : "Created:",
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
  } catch (error) {
    if (error instanceof CliError) {
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
    throw error;
  }
}
