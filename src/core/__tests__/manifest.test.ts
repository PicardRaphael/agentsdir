import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  ManifestError,
  readManifest,
  renderManifest,
  writeManifest,
  type Manifest,
} from "../manifest.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentsdir-manifest-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  tempDirs = [];
});

function sampleManifest(): Manifest {
  return {
    schema: MANIFEST_SCHEMA,
    cliVersion: "0.0.0",
    project: { name: "demo", stack: ["node", "python"] },
    harness: { enabled: ["claude", "codex", "cursor"] },
    packs: { installed: ["core"] },
    projections: {
      mode: "copy",
      hashes: { "CLAUDE.md": "sha256:abc", ".claude/rules": "sha256:def" },
    },
  };
}

describe("03 - manifest .agents.toml", () => {
  it("Given a manifest state, When it is written then read back, Then every field round-trips (schema, cli-version, project, harness, packs, projections)", async () => {
    const dir = await makeTempDir();
    const manifest = sampleManifest();
    await writeManifest(dir, manifest);
    await expect(readManifest(dir)).resolves.toEqual(manifest);
  });

  it("Given the documented schema, When the manifest is rendered, Then the raw TOML pins the exact key and section names, the ownership header and LF endings", () => {
    const raw = renderManifest(sampleManifest());
    expect(raw.split("\n", 1)[0]).toBe(
      "# .agents.toml — agentsdir manifest. Managed by the CLI; do not edit by hand.",
    );
    expect(raw).toContain("\nschema = 1");
    expect(raw).toContain('\ncli-version = "0.0.0"');
    expect(raw).toContain("\n[project]");
    expect(raw).toContain("\n[harness]");
    expect(raw).toContain("\n[packs]");
    expect(raw).toContain("\n[projections]");
    expect(raw).toContain("\n[projections.hashes]");
    expect(raw).not.toContain("\r");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("Given the same state with hashes inserted in different orders, When written twice, Then the two files are identical byte for byte", async () => {
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();
    const manifestA = sampleManifest();
    const manifestB = sampleManifest();
    manifestB.projections.hashes = {
      ".claude/rules": "sha256:def",
      "CLAUDE.md": "sha256:abc",
    };
    await writeManifest(dirA, manifestA);
    await writeManifest(dirB, manifestB);
    const bytesA = await readFile(join(dirA, MANIFEST_FILE));
    const bytesB = await readFile(join(dirB, MANIFEST_FILE));
    expect(bytesA.equals(bytesB)).toBe(true);
  });

  it("Given projections in symlink mode with no hashes, When written, Then the file omits the hashes table and reads back with empty hashes", async () => {
    const dir = await makeTempDir();
    const manifest = sampleManifest();
    manifest.projections = { mode: "symlink", hashes: {} };
    await writeManifest(dir, manifest);
    const raw = await readFile(join(dir, MANIFEST_FILE), "utf8");
    expect(raw).not.toContain("[projections.hashes]");
    await expect(readManifest(dir)).resolves.toEqual(manifest);
  });

  it("Given a directory without .agents.toml, When readManifest runs, Then it fails with exit code 2 and points to agentsdir init", async () => {
    const dir = await makeTempDir();
    const error = await readManifest(dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as ManifestError).exitCode).toBe(2);
    expect((error as ManifestError).message).toContain("agentsdir init");
  });

  it("Given a manifest whose schema is newer than this CLI supports, When readManifest runs, Then it fails with exit code 2 and suggests upgrading", async () => {
    const dir = await makeTempDir();
    const raw = renderManifest(sampleManifest()).replace(
      "schema = 1",
      "schema = 99",
    );
    await writeFile(join(dir, MANIFEST_FILE), raw, "utf8");
    const error = await readManifest(dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as ManifestError).exitCode).toBe(2);
    expect((error as ManifestError).message).toContain(
      "newer than this CLI supports",
    );
  });

  it("Given a file that is not valid TOML, When readManifest runs, Then it fails with exit code 2 and an actionable message", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, MANIFEST_FILE), "schema = = 1\n", "utf8");
    const error = await readManifest(dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as ManifestError).exitCode).toBe(2);
    expect((error as ManifestError).message).toContain("not valid TOML");
  });

  it("Given a manifest with an invalid projections mode, When readManifest runs, Then it fails with exit code 2 naming the field", async () => {
    const dir = await makeTempDir();
    const raw = renderManifest(sampleManifest()).replace(
      'mode = "copy"',
      'mode = "auto"',
    );
    await writeFile(join(dir, MANIFEST_FILE), raw, "utf8");
    const error = await readManifest(dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as ManifestError).exitCode).toBe(2);
    expect((error as ManifestError).message).toContain("[projections].mode");
  });
});
