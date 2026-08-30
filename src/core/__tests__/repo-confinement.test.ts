import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../../commands/init.js";
import { runSync } from "../../commands/sync.js";
import { EXIT_CODES } from "../../exit-codes.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
} from "../../test-support/index.js";
import { detectSymlinkSupport } from "../detect.js";
import { resolveInsideRepo } from "../fs-utils.js";

const probeDir = await makeTempDir("confinement-probe");
const symlinkSupported = (await detectSymlinkSupport(probeDir)).supported;

/**
 * A cloned repository is untrusted input. Its manifest, its lock and its
 * directory layout all feed paths into the engine, and `path.join` normalises
 * `..` instead of rejecting it — so a crafted entry was enough to make the CLI
 * read, write or delete outside the git root it resolved. Containment is the
 * product's core promise; these tests are what make it a checked property.
 */
describe("core - paths from the repository stay inside it", () => {
  it("Given a path that escapes the root, When it is resolved, Then it is refused", () => {
    const root = "/repo";
    expect(() => resolveInsideRepo(root, "../outside/file")).toThrow(
      /outside the repository/,
    );
    expect(() => resolveInsideRepo(root, "a/../../b")).toThrow(
      /outside the repository/,
    );
  });

  it("Given a path inside the root, When it is resolved, Then it is accepted", () => {
    expect(() =>
      resolveInsideRepo("/repo", ".claude/rules/x.md"),
    ).not.toThrow();
    expect(() => resolveInsideRepo("/repo", "a/b/../c.md")).not.toThrow();
  });

  it("Given a manifest declaring a projection outside the repo, When sync runs, Then it refuses and deletes nothing", async () => {
    const outsideDir = await makeTempDir("confinement-outside");
    const victim = join(outsideDir, "precious.txt");
    await writeFile(victim, "not yours\n", "utf8");

    const dir = await makeTempDir("confinement-repo");
    await runInit(dir, initAnswers(), { dryRun: false });
    const manifestPath = join(dir, ".agents.toml");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(
      manifestPath,
      manifest.replace(
        "[projections.hashes]",
        '[projections.hashes]\n"../escape.txt" = "sha256:0000"',
      ),
      "utf8",
    );

    const failure = await runSync(dir, { dryRun: false }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/outside the repository/);
    expect((failure as { exitCode?: number }).exitCode).toBe(
      EXIT_CODES.driftOrInvariant,
    );
    expect(await pathExists(victim)).toBe(true);
  });

  it.runIf(symlinkSupported)(
    "Given .claude/rules shipped as a symlink out of the repo, When init runs, Then nothing is written through it",
    async () => {
      const outsideDir = await makeTempDir("confinement-linked");
      const dir = await makeTempDir("confinement-repo2");
      await writeFile(join(dir, "package.json"), '{"n":1}\n', "utf8");
      await mkdir(join(dir, ".claude"), { recursive: true });
      await symlink(outsideDir, join(dir, ".claude", "rules"), "dir");

      const failure = await runInit(dir, initAnswers(), {
        dryRun: false,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/symlink/);
      expect(await pathExists(join(outsideDir, "tasks.md"))).toBe(false);
      expect(await pathExists(join(outsideDir, "memory.md"))).toBe(false);
    },
  );

  it.runIf(symlinkSupported)(
    "Given a rule that is a symlink out of the repo, When sync runs, Then its content never reaches AGENTS.md",
    async () => {
      const outside = join(await makeTempDir("confinement-secret"), "s.md");
      await writeFile(outside, "TOP SECRET USER DATA\n", "utf8");
      const dir = await makeTempDir("confinement-repo3");
      await runInit(dir, initAnswers(), { dryRun: false });
      await symlink(outside, join(dir, ".agents", "rules", "leak.md"));

      await runSync(dir, { dryRun: false }).catch(() => undefined);
      expect(await readFile(join(dir, "AGENTS.md"), "utf8")).not.toContain(
        "TOP SECRET",
      );
    },
  );
});
