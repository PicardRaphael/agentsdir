import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SymlinkSupport {
  supported: boolean;
  reason: string;
}

/**
 * Empirically checks whether `dir` accepts real symlinks: creates a temporary
 * link, verifies its type on disk (`lstat`), then removes it. Never trusts the
 * platform alone — Windows may or may not allow symlinks depending on
 * Developer Mode and privileges.
 */
export async function detectSymlinkSupport(
  dir: string,
): Promise<SymlinkSupport> {
  const probePath = join(dir, `.agentsdir-symlink-probe-${randomUUID()}`);
  try {
    await symlink("agentsdir-probe-target", probePath, "file");
    const probeStat = await lstat(probePath);
    if (!probeStat.isSymbolicLink()) {
      return {
        supported: false,
        reason:
          "the created link materialized as a regular file instead of a symlink",
      };
    }
    return {
      supported: true,
      reason: "a real symlink was created and verified",
    };
  } catch (error) {
    const code = errorCode(error);
    const hint =
      code === "EPERM"
        ? " — on Windows, enable Developer Mode or run elevated"
        : "";
    return {
      supported: false,
      reason: `symlink creation failed (${code})${hint}`,
    };
  } finally {
    await rm(probePath, { force: true });
  }
}

export interface GitSymlinksInfo {
  isGitRepo: boolean;
  /** Value of `git config core.symlinks`, or "unset" when the key is absent. */
  coreSymlinks: "true" | "false" | "unset";
  /** Paths tracked as symlinks (index mode 120000) but present on disk as regular files. */
  materializedSymlinks: string[];
}

/**
 * Reads `core.symlinks` and flags symlinks already materialized as text files
 * (index mode 120000 but an ordinary file on disk) — the drift `check` must
 * catch later.
 */
export async function detectGitSymlinks(dir: string): Promise<GitSymlinksInfo> {
  if (!(await isGitRepo(dir))) {
    return {
      isGitRepo: false,
      coreSymlinks: "unset",
      materializedSymlinks: [],
    };
  }
  return {
    isGitRepo: true,
    coreSymlinks: await readCoreSymlinks(dir),
    materializedSymlinks: await findMaterializedSymlinks(dir),
  };
}

export type StackId = "node" | "python" | "go" | "rust" | "ruby" | "php";

export interface StackInfo {
  id: StackId;
  markerFile: string;
  /** Suggested commands only — agentsdir never imposes them. */
  suggestions: { dev?: string; test?: string; lint?: string };
}

const STACK_MARKERS: readonly StackInfo[] = [
  {
    id: "node",
    markerFile: "package.json",
    suggestions: { dev: "npm run dev", test: "npm test", lint: "npm run lint" },
  },
  {
    id: "python",
    markerFile: "pyproject.toml",
    suggestions: { test: "pytest", lint: "ruff check ." },
  },
  {
    id: "go",
    markerFile: "go.mod",
    suggestions: { test: "go test ./...", lint: "go vet ./..." },
  },
  {
    id: "rust",
    markerFile: "Cargo.toml",
    suggestions: { test: "cargo test", lint: "cargo clippy" },
  },
  {
    id: "ruby",
    markerFile: "Gemfile",
    suggestions: { test: "bundle exec rake test", lint: "bundle exec rubocop" },
  },
  {
    id: "php",
    markerFile: "composer.json",
    suggestions: { test: "composer run test", lint: "composer run lint" },
  },
];

/**
 * Recognizes the repo's stack(s) from their marker files, in a fixed order so
 * the result is deterministic.
 */
export async function detectStack(dir: string): Promise<StackInfo[]> {
  const found: StackInfo[] = [];
  for (const stack of STACK_MARKERS) {
    if (await isFile(join(dir, stack.markerFile))) {
      found.push(stack);
    }
  }
  return found;
}

export interface HarnessesInfo {
  claudeDir: boolean;
  codexDir: boolean;
  cursorDir: boolean;
  claudeMd: boolean;
  agentsMd: boolean;
}

/** Detects harness material already present — raw input for doctor and, later, migrate. */
export async function detectHarnesses(dir: string): Promise<HarnessesInfo> {
  const [claudeDir, codexDir, cursorDir, claudeMd, agentsMd] =
    await Promise.all([
      isDirectory(join(dir, ".claude")),
      isDirectory(join(dir, ".codex")),
      isDirectory(join(dir, ".cursor")),
      isFile(join(dir, "CLAUDE.md")),
      isFile(join(dir, "AGENTS.md")),
    ]);
  return { claudeDir, codexDir, cursorDir, claudeMd, agentsMd };
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", dir, "rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

async function readCoreSymlinks(
  dir: string,
): Promise<"true" | "false" | "unset"> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      dir,
      "config",
      "--type=bool",
      "--get",
      "core.symlinks",
    ]);
    return stdout.trim() === "true" ? "true" : "false";
  } catch {
    // git config --get exits 1 when the key is absent
    return "unset";
  }
}

async function findMaterializedSymlinks(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", dir, "ls-files", "-sz"]);
  const materialized: string[] = [];
  for (const entry of stdout.split("\0")) {
    if (!entry.startsWith("120000 ")) continue;
    const tabIndex = entry.indexOf("\t");
    if (tabIndex === -1) continue;
    const relPath = entry.slice(tabIndex + 1);
    try {
      if ((await lstat(join(dir, relPath))).isFile()) {
        materialized.push(relPath);
      }
    } catch {
      // absent from disk: missing, not materialized
    }
  }
  return materialized;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code) return code;
  }
  return "unknown";
}
