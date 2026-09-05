import { defineCommand } from "citty";
import { asUserFacingError } from "../core/errors.js";
import { readManifest, type ProjectionMode } from "../core/manifest.js";
import { resolveRepoRoot } from "../core/repo.js";
import {
  validateRepo,
  type ValidateOptions,
  type Violation,
} from "../core/validate.js";
import { EXIT_CODES, type ExitCode } from "../exit-codes.js";

export interface CheckResult {
  violations: Violation[];
  exitCode: ExitCode;
  mode: ProjectionMode;
}

/**
 * Strictly read-only: validates and reports, never writes. It does invoke the
 * hook scripts of the repository once each (invariant 15) — the user's own
 * code, bounded by `hook-protocol.ts`.
 */
export async function runCheck(
  root: string,
  options: ValidateOptions = {},
): Promise<CheckResult> {
  const manifest = await readManifest(root);
  const violations = await validateRepo(root, manifest, options);
  const failed = violations.some((violation) => violation.severity === "error");
  return {
    violations,
    exitCode: failed ? EXIT_CODES.driftOrInvariant : EXIT_CODES.ok,
    mode: manifest.projections.mode,
  };
}

export function renderCheckReport(result: CheckResult): string {
  const lines = result.violations.map(
    (violation) =>
      `${violation.severity === "info" ? "info " : "drift"}  ${violation.path} · ${violation.rule} · ${violation.message}`,
  );
  const errors = result.violations.filter(
    (violation) => violation.severity === "error",
  ).length;
  lines.push(
    errors === 0
      ? "Check passed — no drift, no violated invariant."
      : `Check failed — ${errors} violation(s); each line above names the fix.`,
  );
  return lines.join("\n");
}

export const checkCommand = defineCommand({
  meta: {
    name: "check",
    description:
      "Verify invariants, projection drift and lock fingerprints (read-only, CI-friendly)",
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
      const result = await runCheck(root);
      if (json) {
        console.log(
          JSON.stringify({
            command: "check",
            mode: result.mode,
            changes: [],
            errors: result.violations,
            exitCode: result.exitCode,
          }),
        );
      } else {
        console.log(renderCheckReport(result));
      }
      process.exitCode = result.exitCode;
    } catch (rawError) {
      const error = asUserFacingError(rawError);
      if (error !== undefined) {
        if (json) {
          console.log(
            JSON.stringify({
              command: "check",
              mode: null,
              changes: [],
              errors: [
                {
                  path: "",
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
