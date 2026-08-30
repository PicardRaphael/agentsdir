import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { detectSymlinkSupport } from "../src/core/detect.js";
import { makeTempDir, runCli } from "../src/test-support/index.js";

const execFileAsync = promisify(execFile);

const probeDir = await mkdtemp(join(tmpdir(), "agentsdir-e2e-probe-"));
const symlinkSupported = (await detectSymlinkSupport(probeDir)).supported;
await rm(probeDir, { recursive: true, force: true });

type Stack = "typescript" | "python";

/** A demo repo of the given stack: a git repo plus the stack marker file. */
async function makeDemoRepo(stack: Stack): Promise<string> {
  const dir = await makeTempDir(`e2e-${stack}`);
  await execFileAsync("git", ["-C", dir, "init"]);
  if (stack === "typescript") {
    await writeFile(
      join(dir, "package.json"),
      '{ "name": "demo", "private": true }\n',
      "utf8",
    );
  } else {
    await writeFile(
      join(dir, "pyproject.toml"),
      '[project]\nname = "demo"\n',
      "utf8",
    );
  }
  return dir;
}

/** The release journey from the task: init --yes, then add skill, then check. */
async function runJourney(dir: string, mode: "symlink" | "copy") {
  const init = await runCli(dir, ["init", "--yes", "--mode", mode]);
  expect(init.code, init.stderr).toBe(0);
  const add = await runCli(dir, ["add", "skill", "demo-flow"]);
  expect(add.code, add.stderr).toBe(0);
  const check = await runCli(dir, ["check"]);
  expect(check.code, check.stdout).toBe(0);
  expect(check.stdout).toContain("Check passed");
}

async function expectSkillArtifacts(dir: string, name: string): Promise<void> {
  for (const rel of [`SKILL.md`, `agents/openai.yaml`, `assets/icon.svg`]) {
    const path = join(dir, ".agents", "skills", name, ...rel.split("/"));
    expect((await lstat(path)).isFile(), `${name}/${rel}`).toBe(true);
  }
}

describe.each<Stack>(["typescript", "python"])(
  "14 - release journey on a %s demo repo",
  (stack) => {
    it("Given a fresh repo, When init --yes, add skill and check run in copy mode, Then the journey ends green", async () => {
      const dir = await makeDemoRepo(stack);
      await runJourney(dir, "copy");
      await expectSkillArtifacts(dir, "demo-flow");
      const manifest = await readFile(join(dir, ".agents.toml"), "utf8");
      expect(manifest).toContain('mode = "copy"');
      expect(manifest).toContain(
        stack === "typescript" ? '"node"' : '"python"',
      );
      // copy mode: the bridge is a regular file carrying the generated header
      const bridge = await lstat(join(dir, "CLAUDE.md"));
      expect(bridge.isSymbolicLink()).toBe(false);
      expect(bridge.isFile()).toBe(true);
    });

    it.runIf(symlinkSupported)(
      "Given a fresh repo, When the same journey runs in symlink mode, Then the Claude projections are real symlinks and check ends green",
      async () => {
        const dir = await makeDemoRepo(stack);
        await runJourney(dir, "symlink");
        await expectSkillArtifacts(dir, "demo-flow");
        const manifest = await readFile(join(dir, ".agents.toml"), "utf8");
        expect(manifest).toContain('mode = "symlink"');
        expect((await lstat(join(dir, "CLAUDE.md"))).isSymbolicLink()).toBe(
          true,
        );
      },
    );
  },
);

describe("14 - npx skills interoperability", () => {
  it("Given a skill installed by another tool, When sync and check run, Then the skill keeps its bytes, gets no artifact, and check passes", async () => {
    const dir = await makeDemoRepo("typescript");
    const init = await runCli(dir, [
      "init",
      "--yes",
      "--mode",
      "copy",
      "--packs",
      "core",
    ]);
    expect(init.code, init.stderr).toBe(0);
    const skillDir = join(dir, ".agents", "skills", "vendor-notes");
    await mkdir(skillDir, { recursive: true });
    const source =
      "---\nname: vendor-notes\ndescription: Installed by npx skills, open Agent Skills spec only.\n---\n\n# Vendor notes\n\nContent owned by another tool.\n";
    await writeFile(join(skillDir, "SKILL.md"), source, "utf8");
    const sync = await runCli(dir, ["sync"]);
    expect(sync.code, sync.stdout).toBe(0);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(source);
    expect(await readdir(skillDir)).toEqual(["SKILL.md"]);
    const check = await runCli(dir, ["check"]);
    expect(check.code, check.stdout).toBe(0);
    expect(check.stdout).toContain("skill-external");
    expect(check.stdout).toContain("Check passed");
  });
});

describe("14 - assisted creation, scripted end to end", () => {
  it("Given the creator pack, When $setup-context and $create-skill artifacts are produced with scripted answers, Then check is green on the first try", async () => {
    const dir = await makeDemoRepo("typescript");
    const init = await runCli(dir, [
      "init",
      "--yes",
      "--mode",
      "copy",
      "--packs",
      "core,creator",
    ]);
    expect(init.code, init.stderr).toBe(0);
    // the meta-skills themselves are installed and green at check
    for (const name of ["setup-context", "create-skill"]) {
      await expectSkillArtifacts(dir, name);
    }
    expect((await runCli(dir, ["check"])).code).toBe(0);
    // $setup-context outcome: the interview fills user sections of AGENTS.md
    const agentsMdPath = join(dir, "AGENTS.md");
    const agentsMd = await readFile(agentsMdPath, "utf8");
    const userSection =
      "\n## Working agreements\n\nInterview answers captured by $setup-context.\n";
    await writeFile(agentsMdPath, agentsMd + userSection, "utf8");
    // $create-skill outcome: the generator runs with scripted (default) answers
    const add = await runCli(dir, ["add", "skill", "release-notes"]);
    expect(add.code, add.stderr).toBe(0);
    await expectSkillArtifacts(dir, "release-notes");
    // sync must keep the user's sections byte for byte, and check stays green
    const sync = await runCli(dir, ["sync"]);
    expect(sync.code, sync.stdout).toBe(0);
    expect(await readFile(agentsMdPath, "utf8")).toContain(userSection);
    const check = await runCli(dir, ["check"]);
    expect(check.code, check.stdout).toBe(0);
    expect(check.stdout).toContain("Check passed");
  });
});
