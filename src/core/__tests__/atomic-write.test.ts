import { readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectSymlinkSupport } from "../detect.js";
import { makeTempDir } from "../../test-support/index.js";
import { writeFileAtomic } from "../fs-utils.js";

const probeDir = await makeTempDir("atomic-probe");
const symlinkSupported = (await detectSymlinkSupport(probeDir)).supported;

/**
 * Files land whole or not at all. The bytes go to a sibling temporary file and
 * a single rename puts them in place, so an interrupted run leaves either the
 * old content or the new one — never the truncated file that used to need its
 * own repair path.
 */
describe("core - atomic writes", () => {
  it("Given content, When it is written, Then the file holds it and no temporary file survives", async () => {
    const dir = await makeTempDir("atomic");
    const path = join(dir, "target.md");
    await writeFileAtomic(path, "hello\n");
    expect(await readFile(path, "utf8")).toBe("hello\n");
    expect(
      (await readdir(dir)).filter((name) => name.startsWith(".agentsdir-tmp-")),
    ).toEqual([]);
  });

  it("Given an existing file, When it is rewritten, Then the new content replaces it whole", async () => {
    const dir = await makeTempDir("atomic");
    const path = join(dir, "target.md");
    await writeFile(path, "old\n", "utf8");
    await writeFileAtomic(path, "new content\n");
    expect(await readFile(path, "utf8")).toBe("new content\n");
  });

  it("Given an existing file, When an exclusive write targets it, Then it refuses and the content is untouched", async () => {
    const dir = await makeTempDir("atomic");
    const path = join(dir, "target.md");
    await writeFile(path, "mine\n", "utf8");
    await expect(
      writeFileAtomic(path, "theirs\n", { exclusive: true }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("mine\n");
  });

  it.runIf(symlinkSupported)(
    "Given a dangling symlink, When an exclusive write targets it, Then it refuses instead of writing through it",
    async () => {
      const dir = await makeTempDir("atomic");
      const outside = join(await makeTempDir("atomic-outside"), "loot.md");
      const path = join(dir, "link.md");
      await symlink(outside, path);
      await expect(
        writeFileAtomic(path, "escaped\n", { exclusive: true }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      await expect(readFile(outside, "utf8")).rejects.toThrow();
    },
  );
});
