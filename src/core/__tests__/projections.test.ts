import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { detectSymlinkSupport } from "../detect.js";
import { CliError } from "../errors.js";
import {
  CLAUDE_MD_COPY,
  GENERATED_HEADER,
  project,
  verify,
} from "../projections.js";

const execFileAsync = promisify(execFile);

const probeDir = await mkdtemp(join(tmpdir(), "agentsdir-proj-probe-"));
const symlinkSupported = (await detectSymlinkSupport(probeDir)).supported;
await rm(probeDir, { recursive: true, force: true });

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentsdir-proj-"));
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

async function makeSources(dir: string): Promise<void> {
  await writeFile(
    join(dir, "AGENTS.md"),
    "# AGENTS\n\nSource of truth.\n",
    "utf8",
  );
  await mkdir(join(dir, ".agents", "rules"), { recursive: true });
  await mkdir(join(dir, ".agents", "skills", "demo"), { recursive: true });
  await mkdir(join(dir, ".agents", "agents"), { recursive: true });
  await writeFile(
    join(dir, ".agents", "rules", "tasks.md"),
    "# Task rule\n",
    "utf8",
  );
  await writeFile(
    join(dir, ".agents", "skills", "demo", "SKILL.md"),
    "# Demo skill\n",
    "utf8",
  );
  await writeFile(
    join(dir, ".agents", "skills", "demo", "icon.svg"),
    "<svg/>",
    "utf8",
  );
}

async function makeGitRepo(coreSymlinks: "true" | "false"): Promise<string> {
  const dir = await makeTempDir();
  await execFileAsync("git", ["-C", dir, "init"]);
  await execFileAsync("git", [
    "-C",
    dir,
    "config",
    "core.symlinks",
    coreSymlinks,
  ]);
  await makeSources(dir);
  return dir;
}

function sha256(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

describe("05 - projections engine (copy mode)", () => {
  it("Given copy mode, When project runs, Then CLAUDE.md contains the @AGENTS.md import followed by the generated header, not a copy of the content", async () => {
    const dir = await makeTempDir();
    await makeSources(dir);
    await project(dir, { mode: "copy" });
    const claudeMd = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toBe(CLAUDE_MD_COPY);
    expect(claudeMd.startsWith("@AGENTS.md\n")).toBe(true);
    expect(claudeMd).toContain(GENERATED_HEADER);
    expect(claudeMd).not.toContain("Source of truth");
  });

  it("Given Markdown and non-Markdown sources, When project runs in copy mode, Then Markdown copies carry the generated header and other files are byte-identical", async () => {
    const dir = await makeTempDir();
    await makeSources(dir);
    await project(dir, { mode: "copy" });
    const ruleCopy = await readFile(
      join(dir, ".claude", "rules", "tasks.md"),
      "utf8",
    );
    expect(ruleCopy.startsWith(`<!-- ${GENERATED_HEADER} -->`)).toBe(true);
    expect(ruleCopy).toContain("# Task rule");
    const iconCopy = await readFile(
      join(dir, ".claude", "skills", "demo", "icon.svg"),
      "utf8",
    );
    expect(iconCopy).toBe("<svg/>");
  });

  it("Given copy mode, When project runs, Then every generated file's sha256 fingerprint is returned for [projections.hashes]", async () => {
    const dir = await makeTempDir();
    await makeSources(dir);
    const result = await project(dir, { mode: "copy" });
    expect(Object.keys(result.hashes)).toEqual([
      "CLAUDE.md",
      ".claude/rules/tasks.md",
      ".claude/skills/demo/SKILL.md",
      ".claude/skills/demo/icon.svg",
    ]);
    for (const [path, fingerprint] of Object.entries(result.hashes)) {
      expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      const onDisk = await readFile(join(dir, ...path.split("/")));
      expect(sha256(onDisk)).toBe(fingerprint);
    }
  });

  it("Given a repo already projected, When project reruns, Then every change is unchanged (byte-for-byte idempotence)", async () => {
    const dir = await makeTempDir();
    await makeSources(dir);
    const first = await project(dir, { mode: "copy" });
    const second = await project(dir, {
      mode: "copy",
      previousHashes: first.hashes,
    });
    expect(
      second.changes.every((change) => change.action === "unchanged"),
    ).toBe(true);
    expect(second.hashes).toEqual(first.hashes);
  });

  it("Given a source edited since the last run, When project reruns with the previous fingerprints, Then the stale copy is rewritten", async () => {
    const dir = await makeTempDir();
    await makeSources(dir);
    const first = await project(dir, { mode: "copy" });
    await writeFile(
      join(dir, ".agents", "skills", "demo", "icon.svg"),
      "<svg>v2</svg>",
      "utf8",
    );
    const second = await project(dir, {
      mode: "copy",
      previousHashes: first.hashes,
    });
    const change = second.changes.find(
      (entry) => entry.path === ".claude/skills/demo/icon.svg",
    );
    expect(change?.action).toBe("write");
    const iconCopy = await readFile(
      join(dir, ".claude", "skills", "demo", "icon.svg"),
      "utf8",
    );
    expect(iconCopy).toBe("<svg>v2</svg>");
  });

  it("Given a projection edited by hand, When project reruns, Then it refuses with exit code 1 instead of overwriting", async () => {
    const dir = await makeTempDir();
    await makeSources(dir);
    const first = await project(dir, { mode: "copy" });
    await writeFile(
      join(dir, ".claude", "skills", "demo", "icon.svg"),
      "<svg>hacked</svg>",
      "utf8",
    );
    await writeFile(
      join(dir, ".agents", "skills", "demo", "icon.svg"),
      "<svg>v2</svg>",
      "utf8",
    );
    const error = await project(dir, {
      mode: "copy",
      previousHashes: first.hashes,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect((error as CliError).message).toContain(
      ".claude/skills/demo/icon.svg",
    );
  });

  it("Given a foreign CLAUDE.md, When project runs in copy mode, Then it refuses with exit code 1 and points to the source of truth", async () => {
    const dir = await makeTempDir();
    await makeSources(dir);
    await writeFile(join(dir, "CLAUDE.md"), "# My own instructions\n", "utf8");
    const error = await project(dir, { mode: "copy" }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect((error as CliError).message).toContain("CLAUDE.md");
  });

  it("Given projected copies later deleted, modified or stripped of their header, When verify runs, Then it reports missing, modified and header-removed", async () => {
    const dir = await makeTempDir();
    await makeSources(dir);
    const { hashes } = await project(dir, { mode: "copy" });
    await rm(join(dir, ".claude", "skills", "demo", "icon.svg"));
    const skillCopyPath = join(dir, ".claude", "skills", "demo", "SKILL.md");
    await writeFile(
      skillCopyPath,
      `${await readFile(skillCopyPath, "utf8")}\nedited\n`,
      "utf8",
    );
    await writeFile(
      join(dir, ".claude", "rules", "tasks.md"),
      "# Task rule\n",
      "utf8",
    );
    const drifts = await verify(dir, { mode: "copy", hashes });
    expect(drifts.map((drift) => [drift.path, drift.kind])).toEqual([
      [".claude/rules/tasks.md", "header-removed"],
      [".claude/skills/demo/SKILL.md", "modified"],
      [".claude/skills/demo/icon.svg", "missing"],
    ]);
  });

  it("Given two different repos, When project runs in copy mode, Then the CLAUDE.md fingerprint is identical because the bridge content is constant", async () => {
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();
    await makeSources(dirA);
    await makeSources(dirB);
    await writeFile(join(dirB, "AGENTS.md"), "# Different content\n", "utf8");
    const resultA = await project(dirA, { mode: "copy" });
    const resultB = await project(dirB, { mode: "copy" });
    expect(resultA.hashes["CLAUDE.md"]).toBe(resultB.hashes["CLAUDE.md"]);
  });
});

describe("05 - projections engine (symlink mode)", () => {
  it("Given git config core.symlinks false, When project runs in symlink mode, Then it refuses with exit code 1 instead of recomputing the mode silently", async () => {
    const dir = await makeGitRepo("false");
    const error = await project(dir, { mode: "symlink" }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect((error as CliError).message).toContain("core.symlinks");
  });

  it.runIf(symlinkSupported)(
    "Given symlink mode, When project runs, Then relative links are created and git indexes them as mode 120000",
    async () => {
      const dir = await makeGitRepo("true");
      await project(dir, { mode: "symlink" });
      const claudeLink = (await readlink(join(dir, "CLAUDE.md"))).replaceAll(
        "\\",
        "/",
      );
      expect(claudeLink).toBe("AGENTS.md");
      const rulesLink = (
        await readlink(join(dir, ".claude", "rules"))
      ).replaceAll("\\", "/");
      expect(rulesLink).toBe("../.agents/rules");
      await expect(readFile(join(dir, "CLAUDE.md"), "utf8")).resolves.toContain(
        "Source of truth",
      );
      await execFileAsync("git", ["-C", dir, "add", "-A"]);
      const { stdout } = await execFileAsync("git", [
        "-C",
        dir,
        "ls-files",
        "-s",
      ]);
      const modes = new Map(
        stdout
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => {
            const [meta = "", path = ""] = line.split("\t");
            return [path, meta.split(" ")[0] ?? ""] as const;
          }),
      );
      expect(modes.get("CLAUDE.md")).toBe("120000");
      expect(modes.get(".claude/rules")).toBe("120000");
      expect(modes.get(".claude/skills")).toBe("120000");
      expect(modes.get(".claude/agents")).toBe("120000");
    },
  );

  it.runIf(symlinkSupported)(
    "Given symlink mode already projected, When project reruns, Then every change is unchanged",
    async () => {
      const dir = await makeGitRepo("true");
      await project(dir, { mode: "symlink" });
      const second = await project(dir, { mode: "symlink" });
      expect(
        second.changes.every((change) => change.action === "unchanged"),
      ).toBe(true);
    },
  );

  it.runIf(symlinkSupported)(
    "Given a symlink replaced by a regular file and another deleted, When verify runs, Then it reports replaced-by-copy and missing",
    async () => {
      const dir = await makeGitRepo("true");
      await project(dir, { mode: "symlink" });
      await unlink(join(dir, "CLAUDE.md"));
      await writeFile(join(dir, "CLAUDE.md"), "materialized copy\n", "utf8");
      await unlink(join(dir, ".claude", "skills"));
      const drifts = await verify(dir, { mode: "symlink", hashes: {} });
      expect(drifts.map((drift) => [drift.path, drift.kind])).toEqual([
        ["CLAUDE.md", "replaced-by-copy"],
        [".claude/skills", "missing"],
      ]);
    },
  );

  it.runIf(symlinkSupported)(
    "Given a link re-pointed at the wrong target, When verify runs, Then it reports modified with the current target",
    async () => {
      const dir = await makeGitRepo("true");
      await project(dir, { mode: "symlink" });
      await unlink(join(dir, ".claude", "agents"));
      await symlink("../.agents/rules", join(dir, ".claude", "agents"), "dir");
      const drifts = await verify(dir, { mode: "symlink", hashes: {} });
      expect(drifts).toEqual([
        {
          path: ".claude/agents",
          kind: "modified",
          detail: expect.stringContaining("../.agents/rules") as string,
        },
      ]);
    },
  );
});
