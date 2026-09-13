import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../../commands/check.js";
import { runDoctor } from "../../commands/doctor.js";
import { runInit } from "../../commands/init.js";
import { runSync } from "../../commands/sync.js";
import { EXIT_CODES } from "../../exit-codes.js";
import {
  initAnswers,
  makeTempDir,
  makeUnreadable,
} from "../../test-support/index.js";
import type { GitSymlinksInfo, SymlinkSupport } from "../detect.js";
import { hookMetadataProblem } from "../hook-registries.js";
import { readManifest } from "../manifest.js";
import { verify } from "../projections.js";

/**
 * Task 22 — a message must never assert a cause it has not verified. The
 * pattern was always the same: a `catch` reads a failed read as an absence,
 * and the message describes the absence. What is asserted here is the
 * distinction the code has to make, errno by errno.
 */

const PROBES = {
  symlinkSupport: () =>
    Promise.resolve<SymlinkSupport>({ supported: true, reason: "test" }),
  gitSymlinks: () =>
    Promise.resolve<GitSymlinksInfo>({
      isGitRepo: true,
      coreSymlinks: "unset",
      materializedSymlinks: [],
    }),
  developerMode: () => Promise.resolve("not-applicable" as const),
  machineHarnesses: () => Promise.resolve([]),
};

describe("22 - a diagnosis names what actually happened", () => {
  it("Given a manifest that exists and cannot be read, When it is read, Then the message says unreadable, not missing", async () => {
    // "not found" would send the user to `init`, which refuses on a repo that
    // is already initialized — an instruction that cannot work
    const dir = await makeTempDir("diagnostics");
    await runInit(dir, initAnswers(), { dryRun: false });
    await makeUnreadable(join(dir, ".agents.toml"));

    const error = await readManifest(dir).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/cannot be read/);
    expect((error as Error).message).not.toMatch(/not found/);
    expect((error as Error).message).toContain(".agents.toml");
  });

  it("Given an unreadable manifest, When doctor runs, Then it reports a finding and keeps its promise of exit 0", async () => {
    const dir = await makeTempDir("diagnostics");
    await runInit(dir, initAnswers(), { dryRun: false });
    await makeUnreadable(join(dir, ".agents.toml"));

    const result = await runDoctor(dir, PROBES);

    expect(result.exitCode).toBe(EXIT_CODES.ok);
    const finding = result.findings.find((entry) => entry.rule === "manifest");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toMatch(/cannot be read/);
    // and it does not tell an initialized repo to initialize itself
    expect(finding?.message).not.toMatch(/agentsdir init/);
  });

  it("Given a projection that exists and cannot be read, When check verifies it, Then the drift says unreadable, not missing", async () => {
    const dir = await makeTempDir("diagnostics");
    await runInit(dir, initAnswers(), { dryRun: false });
    const target = join(dir, ".claude", "rules", "memory.md");
    expect((await readFile(target, "utf8")).length).toBeGreaterThan(0);
    await makeUnreadable(target);

    const drifts = await verify(dir, (await readManifest(dir)).projections);

    const drift = drifts.find(
      (entry) => entry.path === ".claude/rules/memory.md",
    );
    expect(drift?.detail).toMatch(/cannot be read/);
    expect(drift?.detail).not.toMatch(/projection missing/);
  });

  it("Given the same unreadable projection, When sync tries to write it, Then it refuses instead of overwriting what it could not inspect", async () => {
    // classified "absent", the write would land on top of a file nobody could
    // inspect — the half of the diagnosis that verify alone did not cover
    const dir = await makeTempDir("diagnostics");
    await runInit(dir, initAnswers(), { dryRun: false });
    const target = join(dir, ".claude", "rules", "memory.md");
    const undo = await makeUnreadable(target);

    const failure = await runSync(dir, { dryRun: false })
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /refusing to treat a file it cannot inspect as an absent one/,
    );

    // and once the cause is gone, the repository is repairable
    await undo();
    expect((await runSync(dir, { dryRun: false })).exitCode).toBe(
      EXIT_CODES.ok,
    );
  });

  it("Given a hook whose metadata comment is unusable, When check runs, Then it names the file and the reason instead of staying silent", async () => {
    const dir = await makeTempDir("diagnostics");
    await runInit(dir, initAnswers(), { dryRun: false });
    await mkdir(join(dir, ".agents", "hooks"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "hooks", "broken-meta.mjs"),
      '// agentsdir:hook {"event": "PreToolUse"\nprocess.exit(0);\n',
      "utf8",
    );

    const result = await runCheck(dir, { hooks: { timeoutMs: 2000 } });

    const violation = result.violations.find(
      (entry) => entry.rule === "hook-metadata-invalid",
    );
    expect(violation?.path).toBe(".agents/hooks/broken-meta.mjs");
    expect(violation?.message).toMatch(/not valid JSON/);
    expect(violation?.severity).toBe("error");
    expect(result.exitCode).toBe(EXIT_CODES.driftOrInvariant);
  });

  it("Given each shape a metadata comment can take, When it is inspected, Then only the unusable ones are reported", async () => {
    // an absent comment is not a problem: the `<event>-<slug>.mjs` name is a
    // documented way to declare the event
    expect(hookMetadataProblem("process.exit(0);\n")).toBeUndefined();
    expect(
      hookMetadataProblem('// agentsdir:hook {"event":"PreToolUse"}\n'),
    ).toBeUndefined();
    expect(hookMetadataProblem('// agentsdir:hook {"event"\n')).toMatch(
      /not valid JSON/,
    );
    expect(hookMetadataProblem("// agentsdir:hook [1,2]\n")).toMatch(
      /not a JSON object/,
    );
    expect(hookMetadataProblem('// agentsdir:hook {"matcher":"x"}\n')).toMatch(
      /no `event` string/,
    );
    expect(hookMetadataProblem('// agentsdir:hook {"event":"Nope"}\n')).toMatch(
      /unknown event "Nope"/,
    );
  });
});
