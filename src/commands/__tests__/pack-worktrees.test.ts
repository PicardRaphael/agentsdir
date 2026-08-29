import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../core/errors.js";
import {
  readManifest,
  renderManifest,
  writeManifest,
} from "../../core/manifest.js";
import { runCheck } from "../check.js";
import { runInit, type InitAnswers } from "../init.js";
import { runSync } from "../sync.js";
import { runPackAdd, runPackRemove } from "../pack.js";

const execFileAsync = promisify(execFile);

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentsdir-worktrees-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  tempDirs = [];
});

function initAnswers(packs: string[] = ["core"]): InitAnswers {
  return {
    productName: "demo-product",
    description: "A demo product.",
    commands: { test: "npm test" },
    harnesses: ["claude", "codex", "cursor"],
    packs,
    mode: "copy",
    stacks: [],
  };
}

async function initializedRepo(packs?: string[]): Promise<string> {
  const dir = await makeTempDir();
  await runInit(dir, initAnswers(packs), { dryRun: false });
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

/** Initialized repo turned into a real git repo with one commit. */
async function gitRepo(packs?: string[]): Promise<string> {
  const dir = await initializedRepo(packs ?? ["core", "worktrees"]);
  await git(dir, "init");
  await git(dir, "config", "user.email", "ci@example.com");
  await git(dir, "config", "user.name", "CI");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "init", "--no-gpg-sign");
  return dir;
}

/** Adds a linked worktree next to the repo and tracks it for cleanup. */
async function addWorktree(dir: string, name: string): Promise<string> {
  const worktree = `${dir}-${name}`;
  tempDirs.push(worktree);
  await git(dir, "worktree", "add", worktree, "-b", name);
  return worktree;
}

const SCRIPTS = ".agents/scripts/worktrees";

function runNode(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const base = { ...process.env };
  // a leftover harness variable on the host must not steer the tests
  delete base["CODEX_WORKTREE_PATH"];
  delete base["CONDUCTOR_WORKSPACE_PATH"];
  delete base["CURSOR_WORKTREE_PATH"];
  delete base["AGENTSDIR_ALLOW_MAIN"];
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      args,
      { cwd, env: { ...base, ...env } },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolvePromise({
          stdout,
          stderr,
          code: typeof error?.code === "number" ? error.code : 0,
        });
      },
    );
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("12 - pack worktrees", () => {
  it("Given an initialized repo, When pack add worktrees runs, Then scripts, rule and .cursor/worktrees.json are installed, the manifest gains the empty section and check stays clean", async () => {
    const dir = await initializedRepo();
    const result = await runPackAdd(dir, "worktrees", { dryRun: false });
    expect(result.exitCode).toBe(0);
    for (const path of [
      `${SCRIPTS}/worktree-context.mjs`,
      `${SCRIPTS}/worktree-setup.mjs`,
      `${SCRIPTS}/worktree-cleanup.mjs`,
      ".agents/rules/worktrees.md",
      ".cursor/worktrees.json",
    ]) {
      expect(await pathExists(join(dir, ...path.split("/")))).toBe(true);
    }
    const cursor = JSON.parse(
      await readFile(join(dir, ".cursor", "worktrees.json"), "utf8"),
    ) as Record<string, string>;
    expect(cursor["setup-worktree-unix"]).toBe(
      "node ../.agents/scripts/worktrees/worktree-setup.mjs",
    );
    expect(cursor["setup-worktree-windows"]).toBe(
      cursor["setup-worktree-unix"],
    );
    expect(cursor["cleanup-worktree-unix"]).toContain("worktree-cleanup.mjs");
    const manifest = await readManifest(dir);
    expect(manifest.packs.installed).toContain("worktrees");
    expect(manifest.worktrees).toEqual({ setup: [], cleanup: [] });
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain(".agents/rules/worktrees.md");
    // criterion: .codex/environments/environment.toml is never generated
    expect(await pathExists(join(dir, ".codex", "environments"))).toBe(false);
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
  });

  it("Given user commands declared under [worktrees], When sync runs, Then the section survives the manifest rewrite", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "worktrees", { dryRun: false });
    const manifest = await readManifest(dir);
    await writeManifest(dir, {
      ...manifest,
      worktrees: { setup: ["npm ci"], cleanup: ["npm run stop"] },
    });
    const sync = await runSync(dir, { dryRun: false });
    expect(sync.exitCode).toBe(0);
    const after = await readManifest(dir);
    expect(after.worktrees).toEqual({
      setup: ["npm ci"],
      cleanup: ["npm run stop"],
    });
  });

  it("Given the harness variable chain, When worktree-context.mjs runs, Then CODEX wins over CONDUCTOR and CURSOR and the fallback is the cwd", async () => {
    const dir = await gitRepo();
    const worktree = await addWorktree(dir, "wt-a");
    const script = join(dir, ...SCRIPTS.split("/"), "worktree-context.mjs");
    const codexWins = await runNode(dir, [script], {
      CODEX_WORKTREE_PATH: worktree,
      CONDUCTOR_WORKSPACE_PATH: dir,
      CURSOR_WORKTREE_PATH: dir,
    });
    expect(codexWins.code).toBe(0);
    expect(
      (JSON.parse(codexWins.stdout) as { worktreePath: string }).worktreePath,
    ).toBe(resolve(worktree));
    const conductorNext = await runNode(dir, [script], {
      CONDUCTOR_WORKSPACE_PATH: worktree,
      CURSOR_WORKTREE_PATH: dir,
    });
    expect(
      (JSON.parse(conductorNext.stdout) as { worktreePath: string })
        .worktreePath,
    ).toBe(resolve(worktree));
    const cwdFallback = await runNode(worktree, [script]);
    const context = JSON.parse(cwdFallback.stdout) as {
      worktreePath: string;
      mainPath: string;
      isMain: boolean;
      projectName: string;
      portBase: number;
    };
    expect(context.worktreePath).toBe(resolve(worktree));
    expect(context.isMain).toBe(false);
    expect(context.projectName).toBe("demo-product");
    expect(context.portBase).toBeGreaterThanOrEqual(3000);
  });

  it("Given commands declared in the rendered manifest, When context runs, Then the script parses them back (renderer/parser contract)", async () => {
    const dir = await gitRepo();
    const manifest = await readManifest(dir);
    await writeManifest(dir, {
      ...manifest,
      worktrees: {
        setup: ["npm ci", 'echo "a b"'],
        cleanup: ["npm run stop"],
      },
    });
    const script = join(dir, ...SCRIPTS.split("/"), "worktree-context.mjs");
    const run = await runNode(dir, [script]);
    expect(run.code).toBe(0);
    const context = JSON.parse(run.stdout) as {
      setupCommands: string[];
      cleanupCommands: string[];
    };
    expect(context.setupCommands).toEqual(["npm ci", 'echo "a b"']);
    expect(context.cleanupCommands).toEqual(["npm run stop"]);
  });

  it("Given the main working copy, When setup runs, Then it refuses with exit 2 — even when an env var claims the main copy is a worktree — and AGENTSDIR_ALLOW_MAIN=1 overrides", async () => {
    const dir = await gitRepo();
    const script = join(dir, ...SCRIPTS.split("/"), "worktree-setup.mjs");
    const refused = await runNode(dir, [script]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("main working copy");
    // a lying variable cannot bypass the guard: git decides what is main
    const lying = await runNode(dir, [script], {
      CODEX_WORKTREE_PATH: dir,
    });
    expect(lying.code).toBe(2);
    const overridden = await runNode(dir, [script], {
      AGENTSDIR_ALLOW_MAIN: "1",
    });
    expect(overridden.code).toBe(0);
    expect(
      await pathExists(join(dir, ".agents", "output", "worktree-context.json")),
    ).toBe(true);
  });

  it("Given a real git worktree, When setup runs inside it, Then the context file lands atomically and the declared setup commands run from the worktree", async () => {
    const dir = await gitRepo();
    const manifest = await readManifest(dir);
    await writeManifest(dir, {
      ...manifest,
      worktrees: {
        setup: [
          "node -e \"require('fs').writeFileSync('setup-ran.txt','ok')\"",
        ],
        cleanup: [],
      },
    });
    const worktree = await addWorktree(dir, "wt-setup");
    const script = join(dir, ...SCRIPTS.split("/"), "worktree-setup.mjs");
    const run = await runNode(worktree, [script]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("worktree-setup: ready");
    expect(await pathExists(join(worktree, "setup-ran.txt"))).toBe(true);
    const contextFile = join(
      worktree,
      ".agents",
      "output",
      "worktree-context.json",
    );
    expect(await pathExists(contextFile)).toBe(true);
    const output = await readdir(join(worktree, ".agents", "output"));
    expect(output.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it("Given a failing declared command, When setup runs, Then it exits 1 and the transient temp file never survives", async () => {
    const dir = await gitRepo();
    const manifest = await readManifest(dir);
    await writeManifest(dir, {
      ...manifest,
      worktrees: { setup: ['node -e "process.exit(3)"'], cleanup: [] },
    });
    const worktree = await addWorktree(dir, "wt-fail");
    const script = join(dir, ...SCRIPTS.split("/"), "worktree-setup.mjs");
    const run = await runNode(worktree, [script]);
    expect(run.code).toBe(1);
    const output = await readdir(join(worktree, ".agents", "output"));
    expect(output.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it("Given a set-up worktree, When cleanup runs, Then declared commands run, the owned context file is removed and the worktree itself survives with the removal command printed", async () => {
    const dir = await gitRepo();
    const manifest = await readManifest(dir);
    await writeManifest(dir, {
      ...manifest,
      worktrees: {
        setup: [],
        cleanup: [
          "node -e \"require('fs').writeFileSync('cleanup-ran.txt','ok')\"",
        ],
      },
    });
    const worktree = await addWorktree(dir, "wt-clean");
    const setup = join(dir, ...SCRIPTS.split("/"), "worktree-setup.mjs");
    const cleanup = join(dir, ...SCRIPTS.split("/"), "worktree-cleanup.mjs");
    await runNode(worktree, [setup]);
    const run = await runNode(worktree, [cleanup]);
    expect(run.code).toBe(0);
    expect(await pathExists(join(worktree, "cleanup-ran.txt"))).toBe(true);
    expect(
      await pathExists(
        join(worktree, ".agents", "output", "worktree-context.json"),
      ),
    ).toBe(false);
    expect(await pathExists(worktree)).toBe(true);
    expect(run.stdout).toContain("git worktree remove");
  });

  it("Given the pack installed, When pack remove worktrees runs, Then scripts, rule, worktrees.json, index line and the empty manifest section are removed — user commands are kept", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "worktrees", { dryRun: false });
    await runPackRemove(dir, "worktrees", { force: false, dryRun: false });
    expect(await pathExists(join(dir, ".agents", "scripts"))).toBe(true);
    expect(
      await pathExists(join(dir, ...SCRIPTS.split("/"), "worktree-setup.mjs")),
    ).toBe(false);
    expect(
      await pathExists(join(dir, ".agents", "rules", "worktrees.md")),
    ).toBe(false);
    expect(await pathExists(join(dir, ".cursor", "worktrees.json"))).toBe(
      false,
    );
    const manifest = await readManifest(dir);
    expect(manifest.packs.installed).not.toContain("worktrees");
    expect(manifest.worktrees).toBeUndefined();
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain(".agents/rules/worktrees.md");
    expect((await runCheck(dir)).violations).toEqual([]);
    // user-declared commands survive the removal of the pack
    const second = await initializedRepo();
    await runPackAdd(second, "worktrees", { dryRun: false });
    const before = await readManifest(second);
    await writeManifest(second, {
      ...before,
      worktrees: { setup: ["npm ci"], cleanup: [] },
    });
    await runPackRemove(second, "worktrees", { force: false, dryRun: false });
    expect((await readManifest(second)).worktrees).toEqual({
      setup: ["npm ci"],
      cleanup: [],
    });
  });

  it("Given an existing .cursor/worktrees.json, When pack add worktrees runs, Then the file is kept as is with a note", async () => {
    const dir = await initializedRepo();
    const existing = '{\n  "setup-worktree-unix": "./my-setup.sh"\n}\n';
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(join(dir, ".cursor", "worktrees.json"), existing, "utf8");
    const result = await runPackAdd(dir, "worktrees", { dryRun: false });
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(dir, ".cursor", "worktrees.json"), "utf8")).toBe(
      existing,
    );
    expect(
      result.notes.some((note) => note.includes(".cursor/worktrees.json")),
    ).toBe(true);
  });

  it("Given a modified script, When pack remove runs, Then it exits 1 removing nothing without --force", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "worktrees", { dryRun: false });
    const script = join(dir, ...SCRIPTS.split("/"), "worktree-setup.mjs");
    await writeFile(
      script,
      `${await readFile(script, "utf8")}\n// local tweak\n`,
      "utf8",
    );
    let error: unknown;
    try {
      await runPackRemove(dir, "worktrees", { force: false, dryRun: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect(await pathExists(script)).toBe(true);
  });

  it("Given init selecting the worktrees pack, When it completes, Then files and the seeded manifest section are in place, the render round-trips and check reports zero violations", async () => {
    const dir = await initializedRepo(["core", "worktrees"]);
    expect(
      await pathExists(
        join(dir, ...SCRIPTS.split("/"), "worktree-context.mjs"),
      ),
    ).toBe(true);
    expect(await pathExists(join(dir, ".cursor", "worktrees.json"))).toBe(true);
    const manifest = await readManifest(dir);
    expect(manifest.worktrees).toEqual({ setup: [], cleanup: [] });
    expect(renderManifest(manifest)).toContain("[worktrees]");
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
  });
});
