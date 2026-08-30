import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../../commands/init.js";
import { runSync } from "../../commands/sync.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { readdirOrEmpty } from "../fs-utils.js";

/**
 * An absent directory and an unreadable one must never look alike. Reading both
 * as "empty" made `sync` delete the projections of the files it could no longer
 * see — and exit 0 while doing it, with `check` green afterwards. Silent data
 * loss in a tool whose whole promise is that nothing drifts unnoticed.
 */
describe("core - an unreadable directory is not an empty one", () => {
  it("Given a directory that does not exist, When it is listed, Then the answer is an empty list", async () => {
    const dir = await makeTempDir("unreadable");
    expect(await readdirOrEmpty(join(dir, "nowhere"))).toEqual([]);
  });

  it("Given a path that is not a directory, When it is listed, Then it refuses with a usage error naming the path", async () => {
    const dir = await makeTempDir("unreadable");
    const path = join(dir, "a-file");
    await writeFile(path, "not a directory\n", "utf8");
    await expect(readdirOrEmpty(path)).rejects.toMatchObject({
      exitCode: EXIT_CODES.environmentOrUsage,
    });
    await expect(readdirOrEmpty(path)).rejects.toThrow(/Cannot read/);
  });

  it("Given .agents/rules made unreadable, When sync runs, Then it refuses and leaves every projection in place", async () => {
    const dir = await makeTempDir("unreadable");
    await runInit(dir, initAnswers(), { dryRun: false });
    const mirror = join(dir, ".claude", "rules");
    const before = (await readdir(mirror)).sort();
    expect(before.length).toBeGreaterThan(0);

    // a file where the directory belongs: unreadable, not absent
    const rules = join(dir, ".agents", "rules");
    await rename(rules, `${rules}-moved`);
    await writeFile(rules, "", "utf8");

    const result = await runSync(dir, { dryRun: false }).catch(
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Cannot read/);
    expect((await readdir(mirror)).sort()).toEqual(before);

    // once the cause is fixed, the repo is healthy again
    await rm(rules);
    await rename(`${rules}-moved`, rules);
    await mkdir(rules, { recursive: true });
    expect((await runSync(dir, { dryRun: false })).exitCode).toBe(
      EXIT_CODES.ok,
    );
  });
});
