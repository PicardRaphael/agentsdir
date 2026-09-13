import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import type { InitAnswers } from "../commands/init.js";

/**
 * What every test file needs to drive the CLI: a scratch repo, a way to run the
 * compiled binary, and the default init answers. Kept here so a change of
 * contract — a new field of `InitAnswers`, another exit-code convention —
 * lands in one place instead of sixteen.
 */
export const cliPath = fileURLToPath(
  new URL("../../dist/cli.js", import.meta.url),
);

const tempDirs: string[] = [];

/**
 * A temporary directory removed after the test. `prefix` only labels it, so a
 * leftover directory can be traced back to the suite that made it.
 */
export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `agentsdir-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

// registered once for every suite importing this module; Windows needs the
// retries, a just-closed handle can still hold a file for a few milliseconds
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

export interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs the compiled CLI in `cwd`; a non-zero exit is a result, not a throw. */
export function runCli(cwd: string, args: string[]): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          stdout,
          stderr,
          code: typeof error?.code === "number" ? error.code : 0,
        });
      },
    );
  });
}

/** The answers `init --yes` would collect on a bare repo, overridable per test. */
export function initAnswers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    productName: "demo",
    description: "A demo product.",
    commands: { test: "npm test" },
    unverified: {},
    harnesses: ["claude", "codex", "cursor"],
    packs: ["core"],
    mode: "copy",
    stacks: [],
    ...overrides,
  };
}

/**
 * Makes `path` unreadable-as-a-directory, on every platform.
 *
 * `chmod` is the obvious move and it does nothing on Windows, where the CI
 * also runs — a guard proven on one platform is not proven. Putting a regular
 * file where the directory belongs makes `readdir` fail with ENOTDIR
 * everywhere, which is the case these guards exist for: a path that is there
 * and cannot be listed, never a path that is absent.
 *
 * Returns the undo, so a test can prove the repository is healthy again once
 * the cause is removed.
 */
export async function makeUnreadable(
  path: string,
): Promise<() => Promise<void>> {
  const moved = `${path}-moved-by-test`;
  const existed = await pathExists(path);
  if (existed) {
    await rename(path, moved);
  }
  await writeFile(path, "", "utf8");
  return async () => {
    await rm(path, { force: true });
    if (existed) {
      await rename(moved, path);
    }
  };
}

/** True when the path exists — the test-side probe, mirroring core/fs-utils. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
