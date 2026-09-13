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
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { readManifest } from "../manifest.js";

const execFileAsync = promisify(execFile);
const srcRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Task 17 — one gate for writing `.agents.toml`, which is what
 * `docs/architecture.md` had always claimed while four commands rendered and
 * wrote it themselves. They drifted, exactly as duplicated writers do: one
 * rebuilt the manifest field by field and dropped the `[usage]` section on
 * every sync. The guard below is the property, not the list of files.
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

describe("17 - one gate for the manifest", () => {
  it("Given the source tree, When manifest writers are inspected, Then only core/manifest.ts renders it for writing", async () => {
    // `renderManifest` is the smell: a module importing it is a module about
    // to write the manifest on its own. Pure-rendering assertions live in
    // tests, which this scan excludes.
    const offenders = sourceFiles(srcRoot)
      .filter((file) => relative(file) !== "core/manifest.ts")
      .filter((file) => /\brenderManifest\b/.test(readFileSync(file, "utf8")))
      .map(relative);

    expect(offenders).toEqual([]);
  });

  it("Given the source tree, When writes are inspected, Then nothing outside core/manifest.ts writes .agents.toml", async () => {
    const offenders = sourceFiles(srcRoot)
      .filter((file) => relative(file) !== "core/manifest.ts")
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return (
          /MANIFEST_FILE/.test(source) &&
          /write(File|FileAtomic)\s*\(\s*\n?\s*join\(\s*root,\s*MANIFEST_FILE/.test(
            source,
          )
        );
      })
      .map(relative);

    expect(offenders).toEqual([]);
  });

  it("Given a manifest carrying every optional section, When sync runs, Then not one of them is dropped", async () => {
    // the regression that proved the gate was needed: `[usage]` held a user's
    // `enabled = false` and their privacy `exclude` globs, and sync deleted
    // both because it rebuilt the manifest field by field
    const dir = await makeTempDir("manifest-gate");
    await execFileAsync("git", ["-C", dir, "init"]);
    await runInit(dir, initAnswers({ packs: ["core"] }), { dryRun: false });
    await runPackAdd(dir, "usage", { dryRun: false });
    await runPackAdd(dir, "worktrees", { dryRun: false });
    const path = join(dir, ".agents.toml");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        "[projections]",
        '[usage]\nenabled = false\nexclude = [ "src/clients/**" ]\n\n[projections]',
      ),
      "utf8",
    );

    await runSync(dir, { dryRun: false });

    const manifest = await readManifest(dir);
    expect(manifest.usage).toEqual({
      enabled: false,
      exclude: ["src/clients/**"],
    });
    expect(manifest.worktrees).toBeDefined();
  });

  it("Given the same manifest, When pack add and pack remove run, Then the optional sections survive them too", async () => {
    const dir = await makeTempDir("manifest-gate");
    await execFileAsync("git", ["-C", dir, "init"]);
    await runInit(dir, initAnswers({ packs: ["core"] }), { dryRun: false });
    await runPackAdd(dir, "usage", { dryRun: false });
    const path = join(dir, ".agents.toml");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        "[projections]",
        '[usage]\nenabled = false\nexclude = [ "private/**" ]\n\n[projections]',
      ),
      "utf8",
    );

    await runPackAdd(dir, "changelog", { dryRun: false });
    expect((await readManifest(dir)).usage?.enabled).toBe(false);

    await runPackRemove(dir, "changelog", { dryRun: false, force: true });
    expect((await readManifest(dir)).usage).toEqual({
      enabled: false,
      exclude: ["private/**"],
    });
  });

  it("Given a dry run, When sync plans the manifest, Then it announces exactly what a real run writes", async () => {
    const dir = await makeTempDir("manifest-gate");
    await execFileAsync("git", ["-C", dir, "init"]);
    await runInit(dir, initAnswers({ packs: ["core"] }), { dryRun: false });
    await writeFile(
      join(dir, ".agents", "rules", "extra.md"),
      "# Extra\n\nRead before anything.\n",
      "utf8",
    );

    const planned = await runSync(dir, { dryRun: true });
    const before = await readFile(join(dir, ".agents.toml"), "utf8");
    const real = await runSync(dir, { dryRun: false });
    const after = await readFile(join(dir, ".agents.toml"), "utf8");

    const action = (result: typeof planned): string | undefined =>
      result.changes.find((change) => change.path === ".agents.toml")?.action;
    expect(action(planned)).toBe(action(real));
    expect(action(planned)).toBe("updated");
    expect(before).not.toBe(after);

    // and the other half of the contract: nothing to do is reported as nothing
    // to do, and the bytes are left alone — the idempotence `check` rests on
    const again = await runSync(dir, { dryRun: false });
    expect(action(again)).toBe("ok");
    expect(await readFile(join(dir, ".agents.toml"), "utf8")).toBe(after);
  });
});
