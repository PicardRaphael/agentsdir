import { isDirectory, isFile } from "./fs-utils.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";

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

export type StackAction = "dev" | "test" | "lint";
export type StackCommands = Partial<Record<StackAction, string>>;

const STACK_ACTIONS: readonly StackAction[] = ["dev", "test", "lint"];

export interface StackInfo {
  id: StackId;
  markerFile: string;
  /**
   * Commands the repository proves: read from a declaration it carries, or
   * guaranteed by the toolchain its marker file declares. These may be written
   * down as facts.
   */
  commands: StackCommands;
  /**
   * The stack's usual commands that this repository does *not* confirm. They
   * are suggestions to check, never statements — an `AGENTS.md` claiming
   * `npm test` in a repo without that script is worse than one saying nothing,
   * because the agent believes it.
   */
  unverified: StackCommands;
}

interface StackMarker {
  id: StackId;
  markerFile: string;
  /** What this stack usually runs — asserted only where `read` confirms it. */
  conventions: StackCommands;
  /** The commands this repository actually proves. Never throws: an unreadable
   * or malformed marker file proves nothing, which is the honest answer. */
  read: (dir: string, markerFile: string) => Promise<StackCommands>;
}

const STACK_MARKERS: readonly StackMarker[] = [
  {
    id: "node",
    markerFile: "package.json",
    conventions: {
      dev: "npm run dev",
      test: "npm test",
      lint: "npm run lint",
    },
    read: async (dir, markerFile) => {
      const scripts = await readJsonScripts(join(dir, markerFile));
      return {
        ...(scripts.has("dev") ? { dev: "npm run dev" } : {}),
        ...(scripts.has("test") ? { test: "npm test" } : {}),
        ...(scripts.has("lint") ? { lint: "npm run lint" } : {}),
      };
    },
  },
  {
    id: "python",
    markerFile: "pyproject.toml",
    conventions: { test: "pytest", lint: "ruff check ." },
    read: async (dir, markerFile) => {
      const declared = await readPyprojectTools(join(dir, markerFile));
      return {
        ...(declared.has("pytest") ? { test: "pytest" } : {}),
        ...(declared.has("ruff") ? { lint: "ruff check ." } : {}),
      };
    },
  },
  {
    id: "go",
    markerFile: "go.mod",
    conventions: { test: "go test ./...", lint: "go vet ./..." },
    // `test` and `vet` are subcommands of the go tool itself: the module the
    // marker file declares is what makes them runnable, so go.mod *is* the
    // reading. Nothing else has to be installed or declared.
    read: async () => ({ test: "go test ./...", lint: "go vet ./..." }),
  },
  {
    id: "rust",
    markerFile: "Cargo.toml",
    conventions: { test: "cargo test", lint: "cargo clippy" },
    // `cargo test` is built into cargo; `cargo clippy` is a separate component
    // that a Cargo.toml does not promise, so it stays a suggestion.
    read: async () => ({ test: "cargo test" }),
  },
  {
    id: "ruby",
    markerFile: "Gemfile",
    conventions: { test: "bundle exec rake test", lint: "bundle exec rubocop" },
    read: async (dir, markerFile) => {
      const gems = await readGemfileGems(join(dir, markerFile));
      return {
        ...(gems.has("rspec") || gems.has("rspec-rails")
          ? { test: "bundle exec rspec" }
          : {}),
        ...(gems.has("rubocop") ? { lint: "bundle exec rubocop" } : {}),
      };
    },
  },
  {
    id: "php",
    markerFile: "composer.json",
    conventions: { test: "composer run test", lint: "composer run lint" },
    read: async (dir, markerFile) => {
      const scripts = await readJsonScripts(join(dir, markerFile));
      return {
        ...(scripts.has("dev") ? { dev: "composer run dev" } : {}),
        ...(scripts.has("test") ? { test: "composer run test" } : {}),
        ...(scripts.has("lint") ? { lint: "composer run lint" } : {}),
      };
    },
  },
];

/**
 * Recognizes the repo's stack(s) from their marker files, in a fixed order so
 * the result is deterministic, and separates what each marker file *proves*
 * from what it merely suggests.
 */
export async function detectStack(dir: string): Promise<StackInfo[]> {
  const found: StackInfo[] = [];
  for (const stack of STACK_MARKERS) {
    if (!(await isFile(join(dir, stack.markerFile)))) {
      continue;
    }
    const commands = await stack.read(dir, stack.markerFile);
    const unverified: StackCommands = {};
    for (const action of STACK_ACTIONS) {
      const convention = stack.conventions[action];
      if (convention !== undefined && commands[action] === undefined) {
        unverified[action] = convention;
      }
    }
    found.push({
      id: stack.id,
      markerFile: stack.markerFile,
      commands,
      unverified,
    });
  }
  return found;
}

/** Keys of the `scripts` object of a package.json / composer.json. */
async function readJsonScripts(path: string): Promise<Set<string>> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // unreadable or malformed: it declares nothing, which is what we report
    return new Set();
  }
  if (typeof data !== "object" || data === null) {
    return new Set();
  }
  const scripts = (data as Record<string, unknown>)["scripts"];
  if (typeof scripts !== "object" || scripts === null) {
    return new Set();
  }
  return new Set(Object.keys(scripts));
}

/**
 * Tool names a pyproject.toml declares: its `[tool.<name>]` tables plus every
 * package named in a dependency list. A tool the file never mentions is not
 * installed as far as this repository is concerned.
 */
async function readPyprojectTools(path: string): Promise<Set<string>> {
  let data: unknown;
  try {
    data = parseToml(await readFile(path, "utf8"));
  } catch {
    return new Set();
  }
  if (typeof data !== "object" || data === null) {
    return new Set();
  }
  const table = data as Record<string, unknown>;
  const names = new Set<string>();
  const tools = table["tool"];
  if (typeof tools === "object" && tools !== null) {
    for (const name of Object.keys(tools)) {
      names.add(name);
    }
  }
  for (const requirement of collectStrings(table["project"])) {
    const name = requirement.match(/^[A-Za-z0-9._-]+/)?.[0];
    if (name !== undefined) {
      names.add(name.toLowerCase());
    }
  }
  for (const requirement of collectStrings(table["dependency-groups"])) {
    const name = requirement.match(/^[A-Za-z0-9._-]+/)?.[0];
    if (name !== undefined) {
      names.add(name.toLowerCase());
    }
  }
  return names;
}

/** Every string in a nested TOML value — dependency lists live at many depths. */
function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStrings(entry));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((entry) => collectStrings(entry));
  }
  return [];
}

/** Gem names a Gemfile declares — `gem "rubocop"`, quotes either way. */
async function readGemfileGems(path: string): Promise<Set<string>> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return new Set();
  }
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name.toLowerCase());
    }
  }
  return names;
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

/**
 * Node caps a child's stdout at 1 MiB by default. `ls-files -sz` emits roughly
 * fifty bytes plus the path per tracked file, so a repository of a few tens of
 * thousands of files blew past it — and init, sync and doctor all reach here,
 * with no catch on the way. The cap stays, well above any real repository, so a
 * runaway output is still bounded.
 */
const GIT_LS_FILES_MAX_BUFFER = 256 * 1024 * 1024;

async function findMaterializedSymlinks(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", dir, "ls-files", "-sz"],
    { maxBuffer: GIT_LS_FILES_MAX_BUFFER },
  );
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

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code) return code;
  }
  return "unknown";
}

/**
 * Paths git tracks under `prefix`, repo-relative. Used by `check` to catch the
 * one leak a convention cannot prevent: the usage journal committed by
 * mistake. Outside a git repository there is nothing to track, and an empty
 * list is the honest answer.
 */
export async function listTrackedUnder(
  dir: string,
  prefix: string,
): Promise<string[]> {
  if (!(await isGitRepo(dir))) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "ls-files", "-z", "--", prefix],
      { maxBuffer: GIT_LS_FILES_MAX_BUFFER },
    );
    return stdout.split(" ").filter((entry) => entry !== "");
  } catch {
    // a git that refuses to answer proves nothing was committed either
    return [];
  }
}
