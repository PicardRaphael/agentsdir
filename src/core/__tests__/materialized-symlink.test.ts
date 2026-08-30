import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { runCheck } from "../../commands/check.js";
import { runInit } from "../../commands/init.js";
import { runSync } from "../../commands/sync.js";
import { detectSymlinkSupport } from "../detect.js";

const probeDir = await makeTempDir("materialized-probe");
const symlinkSupported = (await detectSymlinkSupport(probeDir)).supported;

/**
 * The founding scenario of this product: a repository projected with symlinks,
 * cloned on a machine that cannot create them. Git then writes the link target
 * as the file content. Such a file is ours, not a stranger — but it used to be
 * classified as foreign, so `check` said "run sync" and `sync` refused, with no
 * documented way out.
 */
describe("core - a symlink materialized by a checkout is ours to repair", () => {
  it.runIf(symlinkSupported)(
    "Given CLAUDE.md materialized as a text file holding the link target, When sync runs, Then the link is restored instead of being refused",
    async () => {
      const dir = await makeTempDir("materialized-repo");
      await runInit(dir, initAnswers({ mode: "symlink" }), { dryRun: false });
      const claudeMd = join(dir, "CLAUDE.md");
      expect((await lstat(claudeMd)).isSymbolicLink()).toBe(true);

      // exactly what git writes when it cannot create the link
      await rm(claudeMd);
      await writeFile(claudeMd, "AGENTS.md", "utf8");

      const drifted = await runCheck(dir);
      expect(drifted.exitCode).toBe(1);
      const violation = drifted.violations.find(
        (candidate) => candidate.path === "CLAUDE.md",
      );
      expect(violation?.message).toContain("materialized");

      const result = await runSync(dir, { dryRun: false });

      expect(result.exitCode).toBe(0);
      expect((await lstat(claudeMd)).isSymbolicLink()).toBe(true);
      expect((await runCheck(dir)).exitCode).toBe(0);
    },
  );

  it.runIf(symlinkSupported)(
    "Given a file at a projection path that agentsdir never wrote, When check runs, Then it names the real fix instead of pointing at sync",
    async () => {
      const dir = await makeTempDir("materialized-foreign");
      await runInit(dir, initAnswers({ mode: "symlink" }), { dryRun: false });
      const claudeMd = join(dir, "CLAUDE.md");
      await rm(claudeMd);
      await writeFile(claudeMd, "# my own notes\n", "utf8");

      const drifted = await runCheck(dir);

      const violation = drifted.violations.find(
        (candidate) => candidate.path === "CLAUDE.md",
      );
      expect(violation?.message).toContain("did not generate");
      expect(violation?.message).toContain("delete it");
      // and sync still refuses to overwrite it
      const failure = await runSync(dir, { dryRun: false }).catch(
        (error: unknown) => error,
      );
      const survived = await readFile(claudeMd, "utf8").catch(() => "");
      expect(survived === "# my own notes\n" || failure instanceof Error).toBe(
        true,
      );
    },
  );
});
