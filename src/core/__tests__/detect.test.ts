import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/index.js";
import {
  detectGitSymlinks,
  detectHarnesses,
  detectStack,
  detectSymlinkSupport,
} from "../detect.js";

const execFileAsync = promisify(execFile);

describe("02 - environment detection: detectSymlinkSupport", () => {
  it("Given a writable temp directory, When detectSymlinkSupport probes it, Then it creates and removes a real symlink probe and returns supported with a reason", async () => {
    const dir = await makeTempDir("detect");
    const result = await detectSymlinkSupport(dir);
    expect(typeof result.supported).toBe("boolean");
    expect(result.reason.length).toBeGreaterThan(0);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("Given a directory where creating a symlink is impossible, When detectSymlinkSupport probes it, Then it returns supported false with a clear reason", async () => {
    const dir = join(await makeTempDir("detect"), "does-not-exist");
    const result = await detectSymlinkSupport(dir);
    expect(result.supported).toBe(false);
    expect(result.reason).toContain("symlink creation failed");
  });
});

describe("02 - environment detection: detectGitSymlinks", () => {
  it("Given a repo where core.symlinks is false, When detectGitSymlinks reads the config, Then it reports the configured value", async () => {
    const dir = await makeTempDir("detect");
    await execFileAsync("git", ["-C", dir, "init"]);
    await execFileAsync("git", ["-C", dir, "config", "core.symlinks", "false"]);
    const result = await detectGitSymlinks(dir);
    expect(result.isGitRepo).toBe(true);
    expect(result.coreSymlinks).toBe("false");
  });

  it("Given a path tracked with index mode 120000 but stored as an ordinary file on disk, When detectGitSymlinks scans the repo, Then it flags the path as a materialized symlink", async () => {
    const dir = await makeTempDir("detect");
    await execFileAsync("git", ["-C", dir, "init"]);
    const targetFile = join(dir, "target-content.txt");
    await writeFile(targetFile, "AGENTS.md", "utf8");
    const { stdout } = await execFileAsync("git", [
      "-C",
      dir,
      "hash-object",
      "-w",
      targetFile,
    ]);
    await execFileAsync("git", [
      "-C",
      dir,
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${stdout.trim()},CLAUDE.md`,
    ]);
    await writeFile(join(dir, "CLAUDE.md"), "AGENTS.md", "utf8");
    const result = await detectGitSymlinks(dir);
    expect(result.materializedSymlinks).toEqual(["CLAUDE.md"]);
  });

  it("Given a directory that is not a git repo, When detectGitSymlinks runs, Then it says so without reading any global config", async () => {
    const dir = await makeTempDir("detect");
    await expect(detectGitSymlinks(dir)).resolves.toEqual({
      isGitRepo: false,
      coreSymlinks: "unset",
      materializedSymlinks: [],
    });
  });
});

describe("02 - environment detection: detectStack", () => {
  it("Given a repo containing package.json and pyproject.toml, When detectStack scans it, Then it returns both stacks with command suggestions it never imposes", async () => {
    const dir = await makeTempDir("detect");
    await writeFile(join(dir, "package.json"), "{}\n", "utf8");
    await writeFile(join(dir, "pyproject.toml"), "\n", "utf8");
    const result = await detectStack(dir);
    expect(result.map((stack) => stack.id)).toEqual(["node", "python"]);
    for (const stack of result) {
      expect(Object.keys(stack.suggestions).length).toBeGreaterThan(0);
    }
  });

  it("Given a directory with no known marker file, When detectStack scans it, Then it returns an empty list", async () => {
    const dir = await makeTempDir("detect");
    await expect(detectStack(dir)).resolves.toEqual([]);
  });
});

describe("02 - environment detection: detectHarnesses", () => {
  it("Given a repo containing .claude/ and AGENTS.md, When detectHarnesses scans it, Then it reports exactly those as present", async () => {
    const dir = await makeTempDir("detect");
    await mkdir(join(dir, ".claude"));
    await writeFile(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
    await expect(detectHarnesses(dir)).resolves.toEqual({
      claudeDir: true,
      codexDir: false,
      cursorDir: false,
      claudeMd: false,
      agentsMd: true,
    });
  });

  it("Given .claude existing as a file instead of a directory, When detectHarnesses scans it, Then it does not count it as a harness directory", async () => {
    const dir = await makeTempDir("detect");
    await writeFile(join(dir, ".claude"), "", "utf8");
    const result = await detectHarnesses(dir);
    expect(result.claudeDir).toBe(false);
  });
});
