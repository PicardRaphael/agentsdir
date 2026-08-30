import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectSymlinkSupport } from "../../core/detect.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { runInit } from "../init.js";

const probeDir = await mkdtemp(join(tmpdir(), "agentsdir-containment-probe-"));
const symlinkSupported = (await detectSymlinkSupport(probeDir)).supported;

/**
 * The CLI writes into the repository it resolved, and nowhere else. A dangling
 * symlink used to defeat that: `stat` follows links, so `AGENTS.md -> /elsewhere`
 * read as absent, was planned as a create, and the plain `writeFile` landed
 * outside the repo — while the report claimed AGENTS.md had been created.
 */
describe("init - stays inside the repository", () => {
  it.runIf(symlinkSupported)(
    "Given a file that is a dangling symlink out of the repo, When init runs, Then it refuses and writes nothing outside",
    async () => {
      const outside = join(await makeTempDir("containment-outside"), "loot.md");
      const repo = await makeTempDir("containment-repo");
      await writeFile(join(repo, "package.json"), '{"n":1}\n', "utf8");
      await symlink(outside, join(repo, "AGENTS.md"));

      const failure = await runInit(repo, initAnswers(), {
        dryRun: false,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/symlink/i);
      expect((failure as { exitCode?: number }).exitCode).toBe(
        EXIT_CODES.driftOrInvariant,
      );
      await expect(readFile(outside, "utf8")).rejects.toThrow();
    },
  );

  it.runIf(symlinkSupported)(
    "Given a symlink pointing at a real file outside the repo, When init runs, Then that file keeps its content",
    async () => {
      const outsideDir = await makeTempDir("containment-real");
      const outside = join(outsideDir, "kept.md");
      await writeFile(outside, "belongs to the user\n", "utf8");
      const repo = await makeTempDir("containment-repo2");
      await writeFile(join(repo, "package.json"), '{"n":1}\n', "utf8");
      await symlink(outside, join(repo, "AGENTS.md"));

      // an existing target is read and block-upserted, never recreated: what
      // matters is that the user's own sections survive untouched
      await runInit(repo, initAnswers(), { dryRun: false }).catch(
        () => undefined,
      );
      expect(await readFile(outside, "utf8")).toContain("belongs to the user");
    },
  );
});
