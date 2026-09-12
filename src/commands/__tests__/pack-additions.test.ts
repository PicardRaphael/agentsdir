import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initAnswers,
  makeTempDir,
  pathExists,
} from "../../test-support/index.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runPackAdd } from "../pack.js";
import { runSync } from "../sync.js";
import { runUpdate } from "../update.js";

/**
 * Two defects found while delivering task 24, both invisible until a pack
 * gained a sixth meta-skill:
 *
 * - `update` walked the lock and nothing else, so content a declared pack
 *   gained after install was named by no entry and was never installed. Every
 *   repository in the wild would have stayed on the artifacts of the version
 *   it first ran `pack add` with.
 * - `init` seeded a sorted lock while `pack add` appended to `skills` in pack
 *   order, so the same declared state had two renderings — against the
 *   byte-for-byte determinism the fingerprints rest on.
 */

interface Lock {
  skills: Record<string, Record<string, unknown>>;
  files?: Record<string, unknown>;
}

async function readLock(root: string): Promise<Lock> {
  return JSON.parse(
    await readFile(join(root, "skills-lock.json"), "utf8"),
  ) as Lock;
}

async function writeLock(root: string, lock: Lock): Promise<void> {
  await writeFile(
    join(root, "skills-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8",
  );
}

/** A repo carrying `creator` as an older CLI would have left it: one skill short. */
async function repoMissingOneMetaSkill(
  absent: string,
): Promise<{ dir: string; before: Lock }> {
  const dir = await makeTempDir("pack-additions");
  await runInit(dir, initAnswers({ packs: ["core"] }), { dryRun: false });
  await runPackAdd(dir, "creator", { dryRun: false });
  // rewind to the state a repo installed before the pack gained `absent`
  // would be in: no folder, no lock entry, the manifest still declaring the pack
  await rm(join(dir, ".agents", "skills", absent), {
    recursive: true,
    force: true,
  });
  await rm(join(dir, ".claude", "skills", absent), {
    recursive: true,
    force: true,
  });
  const before = await readLock(dir);
  delete before.skills[absent];
  await writeLock(dir, before);
  return { dir, before };
}

describe("pack content added after install", () => {
  it("Given a repo installed before the pack gained a skill, When update runs, Then the skill is created, locked as agentsdir and check is green", async () => {
    const { dir } = await repoMissingOneMetaSkill("propose-setup");
    expect(
      await pathExists(join(dir, ".agents", "skills", "propose-setup")),
    ).toBe(false);

    const update = await runUpdate(dir, { dryRun: false });
    expect(update.exitCode).toBe(0);

    for (const rel of [
      "SKILL.md",
      "references/rubrique.md",
      "references/interview.md",
      "agents/openai.yaml",
      "assets/icon.svg",
    ]) {
      expect(
        await pathExists(
          join(dir, ".agents", "skills", "propose-setup", ...rel.split("/")),
        ),
        `propose-setup/${rel} not installed by update`,
      ).toBe(true);
    }
    const lock = await readLock(dir);
    expect(lock.skills["propose-setup"]?.["sourceType"]).toBe("agentsdir");
    expect(lock.skills["propose-setup"]?.["computedHash"]).toMatch(
      /^[0-9a-f]{64}$/,
    );
    // the projection reached the harness too, through the closing sync
    expect(
      await pathExists(
        join(dir, ".claude", "skills", "propose-setup", "SKILL.md"),
      ),
    ).toBe(true);
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
    expect(check.exitCode).toBe(0);
  });

  it("Given the same repo, When update only plans, Then it announces the creation and writes nothing", async () => {
    const { dir } = await repoMissingOneMetaSkill("propose-setup");
    const plan = await runUpdate(dir, { dryRun: true });
    expect(plan.exitCode).toBe(0);
    expect(
      plan.changes.find(
        (change) => change.path === ".agents/skills/propose-setup/SKILL.md",
      )?.action,
    ).toBe("created");
    expect(
      await pathExists(join(dir, ".agents", "skills", "propose-setup")),
    ).toBe(false);
  });

  it("Given a folder of that name the user owns, When update runs, Then it is left byte for byte and never becomes an agentsdir entry", async () => {
    const { dir } = await repoMissingOneMetaSkill("propose-setup");
    // the name is free as far as the lock is concerned, and taken on disk:
    // `pack add` refuses to collide with such a folder, and so must `update`
    const owned = join(dir, ".agents", "skills", "propose-setup");
    await mkdir(owned, { recursive: true });
    const source =
      "---\nname: propose-setup\ndescription: Written by the team, not by agentsdir.\n---\n\n# Ours\n\nHands off.\n";
    await writeFile(join(owned, "SKILL.md"), source, "utf8");

    const update = await runUpdate(dir, { dryRun: false });
    expect(update.exitCode).toBe(0);
    expect(await readFile(join(owned, "SKILL.md"), "utf8")).toBe(source);
    expect((await readLock(dir)).skills["propose-setup"]).toBeUndefined();
  });

  it("Given a repo whose pack content is already complete, When update runs, Then nothing is created and the lock keeps its bytes", async () => {
    const dir = await makeTempDir("pack-additions");
    await runInit(dir, initAnswers({ packs: ["core", "creator"] }), {
      dryRun: false,
    });
    const before = await readFile(join(dir, "skills-lock.json"), "utf8");
    const update = await runUpdate(dir, { dryRun: false });
    expect(update.exitCode).toBe(0);
    expect(update.changes.some((change) => change.action === "created")).toBe(
      false,
    );
    expect(await readFile(join(dir, "skills-lock.json"), "utf8")).toBe(before);
  });
});

describe("skills-lock.json determinism", () => {
  it("Given the same declared state reached two ways, When the locks are compared, Then they are byte for byte identical", async () => {
    // seeded by init…
    const seeded = await makeTempDir("lock-seeded");
    await runInit(seeded, initAnswers({ packs: ["core", "creator"] }), {
      dryRun: false,
    });
    // …and grown by pack add
    const grown = await makeTempDir("lock-grown");
    await runInit(grown, initAnswers({ packs: ["core"] }), { dryRun: false });
    await runPackAdd(grown, "creator", { dryRun: false });

    const seededLock = await readFile(join(seeded, "skills-lock.json"), "utf8");
    const grownLock = await readFile(join(grown, "skills-lock.json"), "utf8");
    expect(grownLock).toBe(seededLock);
    // and the order is the sorted one, not either install order
    expect(Object.keys((await readLock(grown)).skills)).toEqual(
      [...Object.keys((await readLock(grown)).skills)].sort(),
    );
  });

  it("Given a lock an older CLI left in insertion order, When sync runs, Then it is normalised and check stays green", async () => {
    const dir = await makeTempDir("lock-legacy");
    await runInit(dir, initAnswers({ packs: ["core", "creator"] }), {
      dryRun: false,
    });
    const lock = await readLock(dir);
    const reversed: Lock = { ...lock, skills: {} };
    for (const key of Object.keys(lock.skills).reverse()) {
      const entry = lock.skills[key];
      if (entry !== undefined) {
        reversed.skills[key] = entry;
      }
    }
    await writeLock(dir, reversed);

    const sync = await runSync(dir, { dryRun: false });
    expect(sync.exitCode).toBe(0);
    const keys = Object.keys((await readLock(dir)).skills);
    expect(keys).toEqual([...keys].sort());
    expect((await runCheck(dir)).violations).toEqual([]);
  });
});
