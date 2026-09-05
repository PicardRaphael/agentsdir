import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../../commands/check.js";
import { runInit } from "../../commands/init.js";
import { runSync } from "../../commands/sync.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { computeSkillHash } from "../skill-hash.js";

/**
 * A `skills-lock.json` key becomes a path segment: `.agents/skills/<key>`. A
 * lock coming from a cloned repository is untrusted input, so a crafted key
 * would otherwise point the reader at a directory outside the repository —
 * the same class of defect as the four symlink escapes fixed on 2026-08-30.
 */
async function initializedRepo(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

/** Writes a lock whose single `skills` entry is `key`. */
async function writeLockWithKey(
  root: string,
  key: string,
  computedHash: string,
): Promise<void> {
  await writeFile(
    join(root, "skills-lock.json"),
    `${JSON.stringify(
      {
        version: 1,
        skills: { [key]: { sourceType: "github", computedHash } },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** A skill folder outside the repository — what the escape aims at. */
async function skillFolderOutside(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await writeFile(
    join(dir, "SKILL.md"),
    [
      "---",
      "name: evil",
      "description: outside the repository",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

const ESCAPING_KEYS = [
  { label: "a relative escape", key: "../../evil" },
  { label: "an absolute path", key: "/etc/passwd" },
  { label: "a Windows path", key: "..\\..\\evil" },
  { label: "a reserved character", key: "evil:skill" },
];

describe("36 - a lock key never becomes a path out of the repository", () => {
  it.each(ESCAPING_KEYS)(
    "Given a skills-lock.json whose key is $label, When check runs, Then it is refused as an invalid name",
    async ({ key }) => {
      const dir = await initializedRepo("lock-key");
      await writeLockWithKey(dir, key, "0".repeat(64));

      const result = await runCheck(dir);

      const violation = result.violations.find(
        (candidate) => candidate.path === "skills-lock.json",
      );
      // lock-invalid, and nothing else: lock-skill-missing or lock-drift would
      // mean the reader had already gone looking at the other end of the key
      expect(violation?.rule).toBe("lock-invalid");
      expect(violation?.message).toContain("never a path");
      expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
      expect(
        result.violations.some((candidate) =>
          ["lock-skill-missing", "lock-drift", "lock-local-change"].includes(
            candidate.rule,
          ),
        ),
      ).toBe(false);
    },
  );

  it("Given a key that resolves to a real skill folder outside the repo, When check runs, Then the folder is never read", async () => {
    // the sharpest form: the recorded fingerprint is the true one of the folder
    // outside, so a reader that followed the key would find it intact and stay
    // green. Only refusing the key keeps check red.
    const outside = await skillFolderOutside("lock-key-outside");
    const dir = await initializedRepo("lock-key-escape");
    const escape = relative(join(dir, ".agents", "skills"), outside)
      .split(sep)
      .join("/");
    await writeLockWithKey(dir, escape, await computeSkillHash(outside));

    const result = await runCheck(dir);

    const violation = result.violations.find(
      (candidate) => candidate.path === "skills-lock.json",
    );
    expect(violation?.rule).toBe("lock-invalid");
    expect(violation?.message).toContain(escape);
    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
  });

  it("Given that lock, When sync runs, Then it refuses and writes nothing, inside or outside the repo", async () => {
    const outside = await skillFolderOutside("lock-key-outside-sync");
    const before = await readdir(outside);
    const dir = await initializedRepo("lock-key-escape-sync");
    const escape = relative(join(dir, ".agents", "skills"), outside)
      .split(sep)
      .join("/");
    const lock = join(dir, "skills-lock.json");
    await writeLockWithKey(dir, escape, "0".repeat(64));
    const lockBefore = await readFile(lock, "utf8");

    const result = await runSync(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
    expect(result.changes).toEqual([]);
    expect(result.violations.some((v) => v.rule === "lock-invalid")).toBe(true);
    // nothing created outside, and the lock itself not rewritten around the key
    expect(await readdir(outside)).toEqual(before);
    expect(await readFile(lock, "utf8")).toBe(lockBefore);
  });
});
