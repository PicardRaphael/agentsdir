import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { extractBlock } from "../../core/managed-blocks.js";
import { MANIFEST_SCHEMA, readManifest } from "../../core/manifest.js";
import { RULES_INDEX_BLOCK } from "../../core/rules-index.js";
import { computeSkillHash, hashFileContent } from "../../core/skill-hash.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { defaultSkillAnswers } from "../../templates/skill.js";
import { initAnswers, makeTempDir, runCli } from "../../test-support/index.js";
import { runAddRule } from "../add-rule.js";
import { runAddSkill } from "../add-skill.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runSync } from "../sync.js";
import { runUpdate } from "../update.js";

const execFileAsync = promisify(execFile);

const RULE = ".agents/rules/verification.md";
const SKILL = "verify";
const SKILL_MD = `.agents/skills/${SKILL}/SKILL.md`;

/** A repo installed with a pack that ships both a skill and a rule. */
async function installedRepo(): Promise<string> {
  const dir = await makeTempDir("update");
  await runInit(dir, initAnswers({ packs: ["core", "verification"] }), {
    dryRun: false,
  });
  return dir;
}

/** The same, as a real git repository: the CLI resolves its root from `.git`. */
async function installedGitRepo(): Promise<string> {
  const dir = await installedRepo();
  await execFileAsync("git", ["-C", dir, "init"]);
  return dir;
}

function abs(dir: string, path: string): string {
  return join(dir, ...path.split("/"));
}

function read(dir: string, path: string): Promise<string> {
  return readFile(abs(dir, path), "utf8");
}

/** Every file of the repo, fingerprinted — the "nothing was written" oracle. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (relative: string): Promise<void> => {
    const here = relative === "" ? dir : join(dir, ...relative.split("/"));
    for (const entry of await readdir(here, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.set(
          path,
          createHash("sha256")
            .update(await readFile(join(dir, ...path.split("/"))))
            .digest("hex"),
        );
      }
    }
  };
  await walk("");
  return files;
}

/** Rewinds the manifest: an installation made by a CLI one schema behind. */
async function rewindSchema(dir: string): Promise<void> {
  const raw = await read(dir, ".agents.toml");
  await writeFile(
    abs(dir, ".agents.toml"),
    raw.replace(/schema = \d+/, "schema = 1"),
    "utf8",
  );
}

interface Lock {
  skills: Record<string, { computedHash: string; installedVersion?: string }>;
  files: Record<string, { computedHash: string; installedVersion?: string }>;
}

async function readLock(dir: string): Promise<Lock> {
  return JSON.parse(await read(dir, "skills-lock.json")) as Lock;
}

async function writeLock(dir: string, lock: Lock): Promise<void> {
  await writeFile(
    abs(dir, "skills-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Makes the repo look like one installed by an older CLI: the older bytes on
 * disk, the projections in step with them, and the lock pinned to them — which
 * is what "installed by agentsdir and intact" means.
 */
async function pretendOlderInstall(dir: string): Promise<void> {
  await writeFile(
    abs(dir, RULE),
    `${await read(dir, RULE)}\nA paragraph the previous version shipped.\n`,
    "utf8",
  );
  await writeFile(
    abs(dir, SKILL_MD),
    `${await read(dir, SKILL_MD)}\nA line the previous version shipped.\n`,
    "utf8",
  );
  await runSync(dir, { dryRun: false });
  const lock = await readLock(dir);
  lock.files[RULE] = {
    ...lock.files[RULE],
    computedHash: hashFileContent(await readFile(abs(dir, RULE))),
  } as Lock["files"][string];
  lock.skills[SKILL] = {
    ...lock.skills[SKILL],
    computedHash: await computeSkillHash(join(dir, ".agents", "skills", SKILL)),
  } as Lock["skills"][string];
  await writeLock(dir, lock);
}

describe("31 - update command", () => {
  it("Given a repo already at the current schema with untouched installed content, When update runs, Then nothing is written and it exits 0", async () => {
    const dir = await installedRepo();
    const before = await snapshot(dir);

    const result = await runUpdate(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(result.migrations).toEqual([]);
    expect(await snapshot(dir)).toEqual(before);
  });

  it("Given a manifest one schema behind, When update runs, Then the declared transformation is applied, the manifest reaches the current schema and check stays green", async () => {
    const dir = await installedRepo();
    await rewindSchema(dir);

    const result = await runUpdate(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(result.migrations.map((step) => `${step.from}->${step.to}`)).toEqual(
      ["1->2"],
    );
    expect((await readManifest(dir)).schema).toBe(MANIFEST_SCHEMA);
    expect((await runCheck(dir)).exitCode).toBe(EXIT_CODES.ok);
  });

  it("Given a manifest one schema behind, When sync runs instead of update, Then the schema is preserved and only update ever advances it", async () => {
    // without this, `sync` stamped the current schema on a repository it had
    // migrated nothing in, and `update` then had nothing left to migrate
    const dir = await installedRepo();
    await rewindSchema(dir);

    await runSync(dir, { dryRun: false });

    expect((await readManifest(dir)).schema).toBe(1);
  });

  it("Given a repo whose user content is fingerprinted beforehand, When update migrates the schema and upgrades installed content, Then no user file was rewritten", async () => {
    const dir = await installedRepo();
    await runAddSkill(dir, defaultSkillAnswers("my-skill", false), {
      dryRun: false,
    });
    await runAddRule(
      dir,
      {
        name: "my-rule",
        hook: "Read before touching the importer.",
        paths: [],
      },
      { dryRun: false },
    );
    const prose = "\nA paragraph only the user wrote, outside every block.\n";
    await writeFile(
      abs(dir, "AGENTS.md"),
      `${await read(dir, "AGENTS.md")}${prose}`,
      "utf8",
    );
    await rewindSchema(dir);
    await pretendOlderInstall(dir);
    const userFiles = [
      ".agents/skills/my-skill/SKILL.md",
      ".agents/skills/my-skill/agents/openai.yaml",
      ".agents/skills/my-skill/assets/icon.svg",
      ".agents/rules/my-rule.md",
    ];
    const before = new Map(
      await Promise.all(
        userFiles.map(
          async (path) =>
            [path, hashFileContent(await readFile(abs(dir, path)))] as const,
        ),
      ),
    );
    const bodyBefore = await outsideRulesIndex(dir);

    const result = await runUpdate(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    for (const [path, hash] of before) {
      expect(hashFileContent(await readFile(abs(dir, path)))).toBe(hash);
    }
    // AGENTS.md: the managed block belongs to the CLI, everything else does not
    expect(await outsideRulesIndex(dir)).toBe(bodyBefore);
    expect(await read(dir, "AGENTS.md")).toContain(prose);
  });

  it("Given installed content one version behind and intact, When update runs, Then it is replaced by the new rendering and re-locked to this CLI version", async () => {
    const dir = await installedRepo();
    const upstreamRule = await read(dir, RULE);
    const upstreamSkill = await read(dir, SKILL_MD);
    await pretendOlderInstall(dir);
    // the precondition of the upgrade: intact content, nothing to report
    expect((await runCheck(dir)).exitCode).toBe(EXIT_CODES.ok);

    const result = await runUpdate(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(await read(dir, RULE)).toBe(upstreamRule);
    expect(await read(dir, SKILL_MD)).toBe(upstreamSkill);
    const lock = await readLock(dir);
    expect(lock.files[RULE]?.computedHash).toBe(hashFileContent(upstreamRule));
    expect(lock.skills[SKILL]?.computedHash).toBe(
      await computeSkillHash(join(dir, ".agents", "skills", SKILL)),
    );
    expect((await runCheck(dir)).exitCode).toBe(EXIT_CODES.ok);
  });

  it('Given the same folder locked as vendored content, When update runs, Then it is left alone: only `sourceType: "agentsdir"` is ours to replace', async () => {
    // the distinction the lock has always carried, finally read by something:
    // a skill imported from elsewhere is never overwritten by an upgrade
    const dir = await installedRepo();
    await pretendOlderInstall(dir);
    const lock = await readLock(dir);
    (lock.skills[SKILL] as Record<string, unknown>)["sourceType"] = "github";
    (lock.skills[SKILL] as Record<string, unknown>)["source"] = "someone/repo";
    await writeLock(dir, lock);
    const vendored = await read(dir, SKILL_MD);

    const result = await runUpdate(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(await read(dir, SKILL_MD)).toBe(vendored);
    expect((await readLock(dir)).skills[SKILL]?.computedHash).toBe(
      lock.skills[SKILL]?.computedHash,
    );
  });

  it("Given installed content modified locally while a new version shipped, When update runs with nobody to ask, Then the file is preserved, the upstream diff is reported and it exits 1", async () => {
    const dir = await installedRepo();
    await pretendOlderInstall(dir);
    const mine = `${await read(dir, RULE)}\nMy own paragraph.\n`;
    await writeFile(abs(dir, RULE), mine, "utf8");

    const result = await runUpdate(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
    // never a silent overwrite: the bytes on disk are the user's, untouched
    expect(await read(dir, RULE)).toBe(mine);
    const conflict = result.conflicts.find((entry) => entry.path === RULE);
    expect(conflict?.resolution).toBe("undecided");
    expect(conflict?.diff).toContain(`+++ ${RULE} (agentsdir upstream)`);
    expect(conflict?.diff).toContain("-My own paragraph.");
    expect(
      result.violations.some(
        (violation) => violation.rule === "update-merge-required",
      ),
    ).toBe(true);
  });

  it("Given that conflict answered `keep mine`, When update runs, Then the file is untouched, the answer is recorded in the lock and the question is not asked again", async () => {
    const dir = await installedRepo();
    await pretendOlderInstall(dir);
    const mine = `${await read(dir, RULE)}\nMy own paragraph.\n`;
    await writeFile(abs(dir, RULE), mine, "utf8");

    const result = await runUpdate(dir, {
      dryRun: false,
      resolve: () => Promise.resolve("kept"),
    });

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(await read(dir, RULE)).toBe(mine);
    expect((await readLock(dir)).files[RULE]?.computedHash).toBe(
      hashFileContent(mine),
    );
    // the way out of the dead end: an acknowledged version is not a conflict
    const again = await runUpdate(dir, { dryRun: false });
    expect(again.exitCode).toBe(EXIT_CODES.ok);
    expect(again.conflicts).toEqual([]);
  });

  it("Given that conflict answered `take the agentsdir version`, When update runs, Then the new rendering replaces the local one", async () => {
    const dir = await installedRepo();
    const upstreamRule = await read(dir, RULE);
    await pretendOlderInstall(dir);
    await writeFile(
      abs(dir, RULE),
      `${await read(dir, RULE)}\nMy own paragraph.\n`,
      "utf8",
    );

    const result = await runUpdate(dir, {
      dryRun: false,
      resolve: () => Promise.resolve("replaced"),
    });

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(await read(dir, RULE)).toBe(upstreamRule);
    expect((await runCheck(dir)).exitCode).toBe(EXIT_CODES.ok);
  });

  it("Given content modified locally that this CLI installs unchanged, When update runs, Then it is kept, reported as information and the run still exits 0", async () => {
    const dir = await installedRepo();
    const mine = `${await read(dir, RULE)}\nMy own paragraph.\n`;
    await writeFile(abs(dir, RULE), mine, "utf8");

    const result = await runUpdate(dir, { dryRun: false });

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(result.preserved).toContain(RULE);
    expect(result.conflicts).toEqual([]);
    expect(await read(dir, RULE)).toBe(mine);
  });

  it("Given a repo needing both a migration and an upgrade, When update runs with --dry-run, Then nothing is written and the plan is exactly the one the real run carries out", async () => {
    const dir = await installedRepo();
    await rewindSchema(dir);
    await pretendOlderInstall(dir);
    const before = await snapshot(dir);

    const dry = await runUpdate(dir, { dryRun: true });

    expect(await snapshot(dir)).toEqual(before);
    const real = await runUpdate(dir, { dryRun: false });
    expect(dry.changes).toEqual(real.changes);
    expect(dry.exitCode).toBe(real.exitCode);
    expect(dry.migrations).toEqual(real.migrations);
    // the plan is not a list of "ok": the upgrade and its projections are in it
    expect(
      dry.changes.filter((change) => change.action === "updated").length,
    ).toBeGreaterThan(1);
  });

  it("Given a repo needing a migration and an upgrade, When update runs, Then every change it announced is what actually happened on disk", async () => {
    // the other half of the --dry-run promise: a faithful plan is worthless if
    // the run does something else. A phantom removal, a file announced and
    // never written, are both caught here and nowhere else.
    const dir = await installedRepo();
    await rewindSchema(dir);
    await pretendOlderInstall(dir);
    const before = await snapshot(dir);

    const result = await runUpdate(dir, { dryRun: false });
    const after = await snapshot(dir);

    const unchangedUnder = (path: string): boolean =>
      [...new Set([...before.keys(), ...after.keys()])]
        .filter((key) => key === path || key.startsWith(`${path}/`))
        .every((key) => before.get(key) === after.get(key));
    for (const change of result.changes) {
      switch (change.action) {
        case "created":
          expect([change.path, before.has(change.path)]).toEqual([
            change.path,
            false,
          ]);
          expect([change.path, after.has(change.path)]).toEqual([
            change.path,
            true,
          ]);
          break;
        case "updated":
          expect([change.path, before.get(change.path)]).not.toEqual([
            change.path,
            after.get(change.path),
          ]);
          break;
        case "removed":
          expect([change.path, before.has(change.path)]).toEqual([
            change.path,
            true,
          ]);
          expect([change.path, after.has(change.path)]).toEqual([
            change.path,
            false,
          ]);
          break;
        case "ok":
          expect([change.path, unchangedUnder(change.path)]).toEqual([
            change.path,
            true,
          ]);
          break;
      }
    }
  });

  it("Given an updated repo, When update runs again, Then it writes nothing, exits 0 and the repo is byte for byte the same", async () => {
    const dir = await installedRepo();
    await rewindSchema(dir);
    await pretendOlderInstall(dir);
    await runUpdate(dir, { dryRun: false });
    const after = await snapshot(dir);

    const again = await runUpdate(dir, { dryRun: false });

    expect(again.exitCode).toBe(EXIT_CODES.ok);
    expect(again.migrations).toEqual([]);
    expect(await snapshot(dir)).toEqual(after);
  });

  it("Given --json, When update runs, Then stdout carries one object with the documented fields", async () => {
    const dir = await installedGitRepo();
    await rewindSchema(dir);

    const { stdout, code } = await runCli(dir, ["update", "--json"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    const report = JSON.parse(stdout) as {
      command: string;
      mode: string;
      changes: { path: string; action: string }[];
      errors: unknown[];
      exitCode: number;
    };
    expect(report.command).toBe("update");
    expect(report.mode).toBe("copy");
    expect(report.errors).toEqual([]);
    expect(report.exitCode).toBe(EXIT_CODES.ok);
    expect(
      report.changes.some((change) => change.path === ".agents.toml"),
    ).toBe(true);
  });

  it("Given a locally modified file with a new version upstream, When `update --json` runs, Then the merge is reported on stdout and the exit code is 1", async () => {
    const dir = await installedGitRepo();
    await pretendOlderInstall(dir);
    await writeFile(
      abs(dir, RULE),
      `${await read(dir, RULE)}\nMy own paragraph.\n`,
      "utf8",
    );

    const { stdout, code } = await runCli(dir, ["update", "--json"]);

    expect(code).toBe(EXIT_CODES.driftOrInvariant);
    const report = JSON.parse(stdout) as {
      errors: { rule: string; message: string }[];
    };
    const merge = report.errors.find(
      (error) => error.rule === "update-merge-required",
    );
    expect(merge?.message).toContain("nothing was overwritten");
  });
});

/** AGENTS.md with the CLI's own block cut out — what the user actually wrote. */
async function outsideRulesIndex(dir: string): Promise<string> {
  const source = await read(dir, "AGENTS.md");
  const block = extractBlock(source, RULES_INDEX_BLOCK, "html") ?? "";
  return source.replace(block, "");
}
