import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runAddSkill } from "../../commands/add-skill.js";
import { runCheck } from "../../commands/check.js";
import { runInit } from "../../commands/init.js";
import { runUpdate } from "../../commands/update.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { defaultSkillAnswers } from "../../templates/skill.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { LOCK_FILE } from "../lock.js";
import type { Violation } from "../validate.js";

const execFileAsync = promisify(execFile);

/**
 * A diagnostic nobody has ever read.
 *
 * `check` is the promise of this product — nothing drifts unnoticed — and it
 * speaks through fifty-three rules. Most were exercised; a handful had never
 * been emitted by any test, which means their message had never been read by
 * anyone. A message is not decoration here: it is the whole repair instruction,
 * and one that names the wrong file or the wrong fix is worse than silence.
 *
 * What follows drives each of those rules out of the code and reads what it
 * says. The lock is where they concentrate: six distinct shapes of a broken
 * `skills-lock.json`, all answering `lock-invalid`, each with its own sentence.
 */

async function repo(packs: string[] = ["core", "creator"]): Promise<string> {
  const dir = await makeTempDir("diagnostics");
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(dir, initAnswers({ packs }), { dryRun: false });
  return dir;
}

async function check(dir: string): Promise<Violation[]> {
  return (await runCheck(dir, { hooks: { timeoutMs: 5000 } })).violations;
}

function ruled(violations: Violation[], rule: string): Violation[] {
  return violations.filter((violation) => violation.rule === rule);
}

/** Rewrites the lock through a transform of its parsed content. */
async function breakLock(
  dir: string,
  mutate: (lock: Record<string, unknown>) => unknown,
): Promise<void> {
  const path = join(dir, LOCK_FILE);
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(path, JSON.stringify(mutate(parsed), null, 2), "utf8");
}

describe("check - the six shapes of a broken lock", () => {
  it("Given a lock that is not JSON at all, When check runs, Then it names the file and points at git history", async () => {
    const dir = await repo();
    await writeFile(join(dir, LOCK_FILE), "{ this is not json", "utf8");

    const violations = ruled(await check(dir), "lock-invalid");

    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe(LOCK_FILE);
    expect(violations[0]?.message).toBe(
      "not valid JSON — restore it from git history.",
    );
  });

  it("Given a lock without its skills table, When check runs, Then it says which table is missing", async () => {
    const dir = await repo();
    await breakLock(dir, () => ({ version: 1 }));

    const violations = ruled(await check(dir), "lock-invalid");

    expect(violations[0]?.message).toBe(
      "missing `skills` table — restore it from git history.",
    );
  });

  it("Given a lock whose skills table is an array, When check runs, Then it is refused like a missing table", async () => {
    // an array is an object to `typeof`: the guard has to reject it explicitly,
    // or `Object.entries` would walk the indices as if they were skill names
    const dir = await repo();
    await breakLock(dir, (lock) => ({ ...lock, skills: [] }));

    expect(ruled(await check(dir), "lock-invalid")[0]?.message).toBe(
      "missing `skills` table — restore it from git history.",
    );
  });

  it("Given a lock key that is a path rather than a folder name, When check runs, Then it is refused before anything reads it", async () => {
    // the key becomes a path segment: a lock from a cloned repository could
    // otherwise send the reader outside the repository
    const dir = await repo();
    await breakLock(dir, (lock) => ({
      ...lock,
      skills: {
        ...(lock["skills"] as Record<string, unknown>),
        "../escape": { computedHash: "deadbeef", sourceType: "agentsdir" },
      },
    }));

    const violations = ruled(await check(dir), "lock-invalid");

    expect(violations[0]?.message).toContain('lock entry "../escape"');
    expect(violations[0]?.message).toContain(
      "a lock key is a folder name, never a path",
    );
  });

  it("Given a lock entry without its hash, When check runs, Then the entry is named and the repair is git history", async () => {
    const dir = await repo();
    let name = "";
    await breakLock(dir, (lock) => {
      const skills = lock["skills"] as Record<string, unknown>;
      name = Object.keys(skills).sort()[0] ?? "";
      return {
        ...lock,
        skills: { ...skills, [name]: { sourceType: "agentsdir" } },
      };
    });

    const violations = ruled(await check(dir), "lock-invalid");

    expect(name).not.toBe("");
    expect(violations[0]?.path).toBe(`.agents/skills/${name}`);
    expect(violations[0]?.message).toBe(
      `lock entry "${name}" has no \`computedHash\` string — restore skills-lock.json from git history.`,
    );
  });

  it("Given a files table that is not a table, When check runs, Then it says what the key is supposed to hold", async () => {
    const dir = await repo();
    await breakLock(dir, (lock) => ({ ...lock, files: [] }));

    expect(ruled(await check(dir), "lock-invalid")[0]?.message).toBe(
      "`files` must be a table of repo-relative paths — restore skills-lock.json from git history.",
    );
  });

  it("Given a files entry without its hash, When check runs, Then it is named by its path", async () => {
    const dir = await repo();
    await breakLock(dir, (lock) => ({
      ...lock,
      files: { ".agents/rules/demo.md": { sourceType: "agentsdir" } },
    }));

    const violations = ruled(await check(dir), "lock-invalid");

    expect(violations[0]?.path).toBe(".agents/rules/demo.md");
    expect(violations[0]?.message).toContain(
      'lock entry ".agents/rules/demo.md" has no `computedHash` string',
    );
  });

  it("Given a files key that escapes the repository, When check runs, Then it is refused before the file is opened", async () => {
    const dir = await repo();
    await breakLock(dir, (lock) => ({
      ...lock,
      files: { "../../etc/passwd": { computedHash: "deadbeef" } },
    }));

    const violations = ruled(await check(dir), "lock-invalid");

    expect(violations[0]?.message).toContain(
      "is not a repo-relative path inside .agents/",
    );
    expect(violations[0]?.message).toContain(
      "a `files` key never escapes the repository",
    );
  });

  it("Given a locked skill whose folder was deleted, When check runs, Then it offers both repairs", async () => {
    const dir = await repo();
    await rm(join(dir, ".agents", "skills", "create-rule"), {
      recursive: true,
      force: true,
    });

    const violations = ruled(await check(dir), "lock-skill-missing");

    expect(violations[0]?.path).toBe(".agents/skills/create-rule");
    expect(violations[0]?.message).toBe(
      "locked skill folder is missing — restore it or remove the lock entry.",
    );
  });
});

describe("check - two skill invariants that had never been emitted", () => {
  it("Given a skill name outside the grammar, When check runs, Then the refusal quotes the name and spells the grammar out", async () => {
    // a trailing dash parses fine and is still not a valid skill name: the
    // frontmatter reaches the invariant instead of failing at the parser
    const dir = await repo(["core"]);
    await runAddSkill(dir, defaultSkillAnswers("demo-skill", false), {
      dryRun: false,
    });
    const folder = join(dir, ".agents", "skills", "demo-skill");
    const renamed = `${folder}-`;
    await rename(folder, renamed);
    const skill = join(renamed, "SKILL.md");
    await writeFile(
      skill,
      (await readFile(skill, "utf8")).split("demo-skill").join("demo-skill-"),
      "utf8",
    );

    const violations = ruled(await check(dir), "skill-name-spec");

    expect(violations[0]?.message).toBe(
      'skill name "demo-skill-" must be 1 to 64 characters of a-z, 0-9 and -, without a leading or trailing dash.',
    );
  });

  it("Given a skill body past the Agent Skills ceiling, When check runs, Then it reports the count and where the depth belongs", async () => {
    const dir = await repo(["core"]);
    await runAddSkill(dir, defaultSkillAnswers("demo-skill", false), {
      dryRun: false,
    });
    const skill = join(dir, ".agents", "skills", "demo-skill", "SKILL.md");
    const raw = await readFile(skill, "utf8");
    const frontmatterEnd = raw.indexOf("\n---\n", 4) + "\n---\n".length;
    const body = Array.from(
      { length: 520 },
      (_, index) => `Line ${index + 1} of a body that will not stop.`,
    ).join("\n");
    await writeFile(
      skill,
      `${raw.slice(0, frontmatterEnd)}\n# Demo skill\n\n${body}\n`,
      "utf8",
    );

    const violations = ruled(await check(dir), "skill-body-depth");

    expect(violations[0]?.message).toBe(
      "body has 521 significant lines; keep it under 500 and move the depth into references/.",
    );
  });
});

describe("update - what it kept without being asked", () => {
  it("Given installed content modified locally with no new version upstream, When update runs, Then it is reported as kept and never blocks", async () => {
    // the quiet half of the update protection: nothing to merge, nothing to
    // overwrite, and the user still has to be told the file is no longer the
    // one this CLI ships — or the next real merge will surprise them
    const dir = await repo();
    const skill = join(dir, ".agents", "skills", "create-rule", "SKILL.md");
    await writeFile(
      skill,
      `${await readFile(skill, "utf8")}\nA line added by hand.\n`,
      "utf8",
    );

    const result = await runUpdate(dir, { dryRun: false });

    const kept = ruled(result.violations, "update-local-change");
    expect(kept[0]?.path).toBe(".agents/skills/create-rule");
    expect(kept[0]?.severity).toBe("info");
    expect(kept[0]?.message).not.toBe("");
    // info never fails a run: the file is kept, and the exit code stays green
    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(await readFile(skill, "utf8")).toContain("A line added by hand.");
  });
});

describe("check - the one diagnostic that cannot be provoked portably", () => {
  it("Given an agent file replaced by a directory, When check runs, Then it is not seen as an unreadable file, and that is the documented limit", async () => {
    // `agent-unreadable` needs a `.md` entry that is a file and still fails to
    // read: only a permission change produces it, and `chmod` does nothing on
    // Windows where the CI also runs. Swapping the kind makes the entry stop
    // being a file, so the walk skips it — this test records why the rule has
    // no trigger here rather than pretending it does.
    const dir = await repo(["core"]);
    await mkdir(join(dir, ".agents", "agents", "ghost.md"), {
      recursive: true,
    });

    const violations = await check(dir);

    expect(ruled(violations, "agent-unreadable")).toEqual([]);
    // and nothing else mistakes it for a valid sub-agent either
    expect(
      violations.some((violation) => violation.path.endsWith("ghost.md")),
    ).toBe(false);
  });
});
