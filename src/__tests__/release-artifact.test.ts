import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "../version.js";

const execAsync = promisify(exec);

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

async function packageJson(): Promise<Record<string, unknown>> {
  const raw = await readFile(new URL("../../package.json", import.meta.url), {
    encoding: "utf8",
  });
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("release artifact", () => {
  it("Given CLI_VERSION, When compared to package.json, Then the two agree — a forgotten bump stamps every client repo with a false provenance", async () => {
    const pkg = await packageJson();
    expect(CLI_VERSION).toBe(pkg["version"]);
  });

  it("Given the published file list, When package.json is read, Then the third-party notice ships with the bundle it covers", async () => {
    const pkg = await packageJson();
    expect(pkg["files"]).toContain("THIRD-PARTY-NOTICES.txt");
  });

  it("Given the ISC and MIT notices lucide requires in all copies, When the bundle is built, Then it carries them itself — dist/ is shipped alone", async () => {
    const bundle = await readFile(
      new URL("../../dist/cli.js", import.meta.url),
      {
        encoding: "utf8",
      },
    );
    const header = bundle.slice(0, 600);
    expect(header).toContain("lucide-static");
    expect(header).toContain("ISC License");
    expect(header).toContain("Cole Bemis");
    expect(header).toContain("THIRD-PARTY-NOTICES.txt");
  });

  it("Given the bundle is executed by node, When it is built, Then the shebang stays on the very first line, ahead of the notice", async () => {
    const bundle = await readFile(
      new URL("../../dist/cli.js", import.meta.url),
      {
        encoding: "utf8",
      },
    );
    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("Given npm pack, When the tarball is listed, Then it contains exactly the files a user needs and nothing more", async () => {
    // exec, not execFile: on Windows npm is a .cmd shim, which execFile
    // refuses to spawn, and args + shell:true is deprecated.
    const { stdout } = await execAsync(
      "npm pack --dry-run --json --ignore-scripts",
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    // --ignore-scripts keeps the prepack build out of stdout; `pretest` has
    // already produced dist/, so the listing is the real one.
    const [entry] = JSON.parse(stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const shipped = (entry?.files ?? []).map((file) => file.path).sort();
    expect(shipped).toEqual([
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "THIRD-PARTY-NOTICES.txt",
      "dist/cli.js",
      "package.json",
    ]);
  });
});
