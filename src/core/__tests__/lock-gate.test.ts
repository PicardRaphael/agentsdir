import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runInit } from "../../commands/init.js";
import { runPackAdd, runPackRemove } from "../../commands/pack.js";
import { runSync } from "../../commands/sync.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
} from "../../test-support/index.js";
import { LOCK_FILE, planLock, renderLock } from "../lock.js";

const execFileAsync = promisify(execFile);
const srcRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Task 18 — one planner for `skills-lock.json`. Three commands used to plan
 * the same file their own way and a fourth read and wrote it on top. What is
 * asserted here is the contract they must not each re-decide: which entries
 * are re-locked, which stay pinned, and that one rendering produces one set of
 * bytes whatever path reached it.
 */

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "test-support") {
        found.push(...sourceFiles(path));
      }
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

function relative(file: string): string {
  return file.slice(srcRoot.length).split("\\").join("/");
}

async function lockOf(dir: string): Promise<Record<string, never>> {
  return JSON.parse(await readFile(join(dir, LOCK_FILE), "utf8")) as Record<
    string,
    never
  >;
}

describe("18 - one planner for the lock", () => {
  it("Given the source tree, When lock writers are inspected, Then nothing outside core/lock.ts writes skills-lock.json", async () => {
    const offenders = sourceFiles(srcRoot)
      .filter((file) => relative(file) !== "core/lock.ts")
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return /write(File|FileAtomic)\s*\(\s*\n?\s*join\(\s*root,\s*(LOCK_FILE|"skills-lock\.json")/.test(
          source,
        );
      })
      .map(relative);

    expect(offenders).toEqual([]);
  });

  it("Given an agentsdir entry and a vendored one, When sync re-locks, Then only the vendored one is recomputed", async () => {
    // the asymmetry IS the protection `update` offers: recomputing an
    // agentsdir fingerprint would bless a local edit and lose it
    const dir = await makeTempDir("lock-gate");
    await execFileAsync("git", ["-C", dir, "init"]);
    await runInit(dir, initAnswers({ packs: ["core", "creator"] }), {
      dryRun: false,
    });
    const lockPath = join(dir, LOCK_FILE);
    const data = JSON.parse(await readFile(lockPath, "utf8")) as {
      skills: Record<string, Record<string, unknown>>;
    };
    data.skills["create-rule"] = {
      ...data.skills["create-rule"],
      source: "github:someone/create-rule",
      sourceType: "github",
      computedHash: "0".repeat(64),
    };
    const pinned = data.skills["create-skill"]?.["computedHash"];
    await writeFile(lockPath, renderLock(data), "utf8");
    // a local edit on both, so both fingerprints would move if recomputed
    for (const skill of ["create-rule", "create-skill"]) {
      const md = join(dir, ".agents", "skills", skill, "SKILL.md");
      await writeFile(
        md,
        `${await readFile(md, "utf8")}\nLocal note.\n`,
        "utf8",
      );
    }

    await runSync(dir, { dryRun: false });

    const after = (await lockOf(dir)) as unknown as {
      skills: Record<string, Record<string, unknown>>;
    };
    expect(after.skills["create-rule"]?.["computedHash"]).not.toBe(
      "0".repeat(64),
    );
    expect(after.skills["create-skill"]?.["computedHash"]).toBe(pinned);
  });

  it("Given the same declared state, When it is reached by init or by pack add, Then the lock holds the same bytes", async () => {
    // `init` seeded a sorted table while `pack add` appended in pack order:
    // one state, two renderings, against the determinism check rests on
    const seeded = await makeTempDir("lock-gate");
    await execFileAsync("git", ["-C", seeded, "init"]);
    await runInit(seeded, initAnswers({ packs: ["core", "creator"] }), {
      dryRun: false,
    });

    const added = await makeTempDir("lock-gate");
    await execFileAsync("git", ["-C", added, "init"]);
    await runInit(added, initAnswers({ packs: ["core"] }), { dryRun: false });
    await runPackAdd(added, "creator", { dryRun: false });

    expect(await readFile(join(added, LOCK_FILE), "utf8")).toBe(
      await readFile(join(seeded, LOCK_FILE), "utf8"),
    );
  });

  it("Given a pack removed down to nothing, When the lock is planned, Then the file goes rather than being left empty", async () => {
    const dir = await makeTempDir("lock-gate");
    await execFileAsync("git", ["-C", dir, "init"]);
    await runInit(dir, initAnswers({ packs: ["core", "creator"] }), {
      dryRun: false,
    });
    expect(await pathExists(join(dir, LOCK_FILE))).toBe(true);

    await runPackRemove(dir, "creator", { dryRun: false, force: true });

    expect(await pathExists(join(dir, LOCK_FILE))).toBe(false);
  });

  it("Given nothing to change, When the lock is planned, Then there is no plan at all", async () => {
    const dir = await makeTempDir("lock-gate");
    await execFileAsync("git", ["-C", dir, "init"]);
    await runInit(dir, initAnswers({ packs: ["core", "creator"] }), {
      dryRun: false,
    });

    expect(await planLock(dir, {})).toBeUndefined();
    // and a delta that changes nothing reports "ok", never a rewrite
    expect((await planLock(dir, { relockVendored: {} }))?.action).toBe("ok");
  });

  it("Given tables in insertion order, When the lock is rendered, Then both come out sorted by key", async () => {
    // one declared state, one set of bytes: the fingerprints and `check` rest
    // on it, and this is the drift that had already happened once
    const rendered = renderLock({
      version: 1,
      skills: { zulu: { computedHash: "z" }, alpha: { computedHash: "a" } },
      files: { ".agents/rules/z.md": { h: 1 }, ".agents/rules/a.md": { h: 2 } },
    });

    const parsed = JSON.parse(rendered) as {
      skills: Record<string, unknown>;
      files: Record<string, unknown>;
    };
    expect(Object.keys(parsed.skills)).toEqual(["alpha", "zulu"]);
    expect(Object.keys(parsed.files)).toEqual([
      ".agents/rules/a.md",
      ".agents/rules/z.md",
    ]);
  });

  it("Given a lock that is valid JSON but not an object, When it is parsed, Then it is refused rather than read as empty", async () => {
    // read as empty, the next write would drop every entry it could not see
    const dir = await makeTempDir("lock-gate");
    await execFileAsync("git", ["-C", dir, "init"]);
    await runInit(dir, initAnswers({ packs: ["core", "creator"] }), {
      dryRun: false,
    });
    await writeFile(join(dir, LOCK_FILE), "[1, 2]\n", "utf8");

    await expect(planLock(dir, { relockVendored: {} })).rejects.toThrow(
      /must contain a JSON object/,
    );
  });

  it("Given a malformed lock, When any command plans it, Then it refuses instead of rewriting what it could not read", async () => {
    const dir = await makeTempDir("lock-gate");
    await execFileAsync("git", ["-C", dir, "init"]);
    await runInit(dir, initAnswers({ packs: ["core", "creator"] }), {
      dryRun: false,
    });
    await writeFile(join(dir, LOCK_FILE), "{ not json", "utf8");

    await expect(planLock(dir, { relockVendored: {} })).rejects.toThrow(
      /not valid JSON/,
    );
    await expect(
      runPackAdd(dir, "changelog", { dryRun: false }),
    ).rejects.toThrow(/not valid JSON/);
  });
});
