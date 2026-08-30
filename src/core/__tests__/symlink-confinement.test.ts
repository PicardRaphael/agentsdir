import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAddHook } from "../../commands/add-hook.js";
import { runInit } from "../../commands/init.js";
import { runPackAdd } from "../../commands/pack.js";
import { runSync } from "../../commands/sync.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
} from "../../test-support/index.js";
import { detectSymlinkSupport } from "../detect.js";
import { resolveHookEvent } from "../hook-registries.js";

const probeDir = await makeTempDir("symlink-probe");
const symlinkSupported = (await detectSymlinkSupport(probeDir)).supported;

/**
 * `mkdir -p` and `readdir` both walk through a symlinked directory without
 * complaining, so a cloned repository shipping one made the CLI read or write
 * outside the git root — and the report looked perfectly ordinary. The guard
 * existed, but only on the copy path: these are the four ways around it.
 */
describe("core - symlinked directories cannot be used to escape the repo", () => {
  it.runIf(symlinkSupported)(
    "Given a rule that is a symlink out of the repo, When init runs, Then its content never reaches AGENTS.md",
    async () => {
      // sync was guarded, init was not: it carried its own copy of
      // listRuleFiles, without the lstat that skips links
      const outside = join(await makeTempDir("symlink-secret"), "s.md");
      await writeFile(outside, "TOP SECRET USER DATA\n", "utf8");
      const dir = await makeTempDir("symlink-repo-rule");
      await writeFile(join(dir, "package.json"), '{"n":1}\n', "utf8");
      await mkdir(join(dir, ".agents", "rules"), { recursive: true });
      await symlink(outside, join(dir, ".agents", "rules", "leak.md"));

      await runInit(dir, initAnswers(), { dryRun: false }).catch(
        () => undefined,
      );

      const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8").catch(
        () => "",
      );
      expect(agentsMd).not.toContain("TOP SECRET");
    },
  );

  it.runIf(symlinkSupported)(
    "Given the rules directory itself shipped as a symlink, When init runs, Then it refuses instead of reading through it",
    async () => {
      // the per-entry lstat cannot see this one: readdir walks through the
      // linked directory, and every outside file then lstats as a regular file
      const outsideDir = await makeTempDir("symlink-linked-rules");
      await writeFile(
        join(outsideDir, "leak.md"),
        "# TOP SECRET USER DATA\n",
        "utf8",
      );
      const dir = await makeTempDir("symlink-repo-rulesdir");
      await writeFile(join(dir, "package.json"), '{"n":1}\n', "utf8");
      await mkdir(join(dir, ".agents"), { recursive: true });
      await symlink(outsideDir, join(dir, ".agents", "rules"), "dir");

      const failure = await runInit(dir, initAnswers(), {
        dryRun: false,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/symlink/);
      const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8").catch(
        () => "",
      );
      expect(agentsMd).not.toContain("TOP SECRET");
    },
  );

  it.runIf(symlinkSupported)(
    "Given .claude shipped as a symlink, When sync switches to symlink mode, Then it refuses and deletes nothing outside",
    async () => {
      // projectCopies guarded this; projectSymlinks did not, and its unlink on
      // a foreign link would have deleted one of the user's own
      const outsideDir = await makeTempDir("symlink-claude-home");
      const victim = join(outsideDir, "settings.json");
      await writeFile(victim, '{"mine":true}\n', "utf8");

      const dir = await makeTempDir("symlink-repo-sync");
      await runInit(dir, initAnswers(), { dryRun: false });
      await rm(join(dir, ".claude"), { recursive: true, force: true });
      await symlink(outsideDir, join(dir, ".claude"), "dir");

      const failure = await runSync(dir, {
        dryRun: false,
        mode: "symlink",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/symlink/);
      expect(await readFile(victim, "utf8")).toBe('{"mine":true}\n');
    },
  );

  it.runIf(symlinkSupported)(
    "Given .claude shipped as a symlink, When add hook runs, Then no registry is written through it",
    async () => {
      // hook registries are written outside the projection engine, so the
      // projection guard never saw them
      const outsideDir = await makeTempDir("symlink-claude-home2");
      const dir = await makeTempDir("symlink-repo-hook");
      await runInit(dir, initAnswers(), { dryRun: false });
      await rm(join(dir, ".claude"), { recursive: true, force: true });
      await symlink(outsideDir, join(dir, ".claude"), "dir");

      const event = resolveHookEvent("PreToolUse");
      if (event === undefined) {
        throw new Error("PreToolUse must resolve to a known event");
      }
      await runAddHook(
        dir,
        { event, slug: "guard", matcher: "Bash" },
        { dryRun: false },
      ).catch(() => undefined);

      expect(await pathExists(join(outsideDir, "settings.json"))).toBe(false);
    },
  );

  it.runIf(symlinkSupported)(
    "Given a pack file shipped as a broken symlink out of the repo, When pack add runs, Then it refuses instead of writing through it",
    async () => {
      // pack add was the last generator still testing collisions with stat,
      // which follows links: a broken one reads as absent, and the write then
      // creates the file at the far end
      const outsideDir = await makeTempDir("symlink-pack-target");
      const escaped = join(outsideDir, "ESCAPED.md");
      const dir = await makeTempDir("symlink-repo-pack");
      await runInit(dir, initAnswers(), { dryRun: false });
      await symlink(escaped, join(dir, ".agents", "rules", "verification.md"));

      await runPackAdd(dir, "verification", { dryRun: false }).catch(
        () => undefined,
      );

      expect(await pathExists(escaped)).toBe(false);
    },
  );
});
