import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliError } from "./errors.js";

const execFileAsync = promisify(execFile);

/** Resolves the git repository root from `cwd` (walks up to `.git/`). */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      cwd,
      "rev-parse",
      "--show-toplevel",
    ]);
    return stdout.trim();
  } catch {
    throw new CliError(
      `Not inside a git repository (searched from ${cwd}). Run agentsdir from a git repo, or create one with \`git init\` first.`,
    );
  }
}
