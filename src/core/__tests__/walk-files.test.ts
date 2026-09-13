import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../exit-codes.js";
import { makeTempDir, makeUnreadable } from "../../test-support/index.js";
import { walkFiles } from "../fs-utils.js";
import { computeSkillHash, listSkillFiles } from "../skill-hash.js";

/**
 * Task 20 — one directory walk instead of three. What is asserted here is what
 * the three copies used to disagree on: the order (the lock fingerprints
 * depend on it), the exclusions (passed in, never hard-coded again), and what
 * an absent directory means against what an unreadable one means.
 */

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await makeTempDir("walk");
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, ...path.split("/"));
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return dir;
}

describe("20 - one directory walk", () => {
  it("Given a nested tree, When it is walked, Then names are sorted in code units, not by locale", async () => {
    // "Z" (0x5A) precedes "a" (0x61) in code units and follows it in most
    // locales — and the lock fingerprints are fed in this exact order, so a
    // localeCompare here would invalidate every entry on another machine
    const dir = await tree({
      "Zebra.md": "z",
      "apple.md": "a",
      "_under.md": "u",
      "nested/b.md": "b",
      "nested/A.md": "A",
    });

    const walked = await walkFiles(dir);

    expect(walked.map((file) => file.rel)).toEqual([
      "Zebra.md",
      "_under.md",
      "apple.md",
      "nested/A.md",
      "nested/b.md",
    ]);
    expect([...walked].sort((a, b) => a.rel.localeCompare(b.rel))).not.toEqual(
      walked,
    );
  });

  it("Given a prefix, When the tree is walked, Then every path carries it and an empty prefix yields bare paths", async () => {
    const dir = await tree({ "a.md": "a", "deep/b.md": "b" });

    expect((await walkFiles(dir)).map((file) => file.rel)).toEqual([
      "a.md",
      "deep/b.md",
    ]);
    expect(
      (await walkFiles(dir, { prefix: ".claude/rules" })).map(
        (file) => file.rel,
      ),
    ).toEqual([".claude/rules/a.md", ".claude/rules/deep/b.md"]);
  });

  it("Given excluded names, When the tree is walked, Then they are neither returned nor descended into", async () => {
    const dir = await tree({
      "keep.md": "k",
      ".git/HEAD": "ref",
      "node_modules/pkg/index.js": "x",
    });

    expect((await walkFiles(dir)).map((file) => file.rel)).toHaveLength(3);
    expect(
      (await walkFiles(dir, { exclude: [".git", "node_modules"] })).map(
        (file) => file.rel,
      ),
    ).toEqual(["keep.md"]);
  });

  it("Given a skill folder holding .git and node_modules, When it is fingerprinted, Then those are excluded and the exclusion comes from the caller", async () => {
    // the mutation this kills: dropping an exclusion, which silently changes
    // every entry of skills-lock.json
    const dir = await tree({
      "SKILL.md": "---\nname: demo\ndescription: Demo.\n---\n\nBody\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      "node_modules/pkg/index.js": "module.exports = 1;\n",
    });
    const clean = await tree({
      "SKILL.md": "---\nname: demo\ndescription: Demo.\n---\n\nBody\n",
    });

    expect(await listSkillFiles(dir)).toEqual(["SKILL.md"]);
    expect(await computeSkillHash(dir)).toBe(await computeSkillHash(clean));
  });

  it("Given an absent directory, When the caller tolerates absence, Then the walk is empty; when it does not, the error surfaces", async () => {
    const dir = await makeTempDir("walk");
    const missing = join(dir, "nowhere");

    expect(
      await walkFiles(missing, { unreadable: "refusing to guess" }),
    ).toEqual([]);
    // a skill folder that must exist: an empty hash would certify a folder
    // that is gone, so absence stays an error here
    await expect(walkFiles(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("Given a directory that exists but cannot be read, When it is walked, Then it refuses with the caller's own reason", async () => {
    const dir = await tree({ "sub/a.md": "a" });
    await makeUnreadable(join(dir, "sub"));

    await expect(
      walkFiles(join(dir, "sub"), {
        unreadable: "refusing to remove files it cannot inspect",
      }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.environmentOrUsage });
    await expect(
      walkFiles(join(dir, "sub"), {
        unreadable: "refusing to remove files it cannot inspect",
      }),
    ).rejects.toThrow(/refusing to remove files it cannot inspect/);
  });

  it("Given the shared walk, When a caller asks for absolute paths, Then it gets both forms and never rebuilds one from the other", async () => {
    const dir = await tree({ "deep/a.md": "a" });

    const [file] = await walkFiles(dir, { prefix: "p" });

    expect(file?.rel).toBe("p/deep/a.md");
    expect(file?.abs).toBe(join(dir, "deep", "a.md"));
  });
});
