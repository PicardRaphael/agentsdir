import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HOOK_PROBE_TIMEOUT_MS } from "../../core/hook-protocol.js";
import { getPackContent } from "../../packs/index.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runPackAdd, runPackRemove } from "../pack.js";
import { runSync } from "../sync.js";

const execFileAsync = promisify(execFile);

/**
 * The default 5-second bound everywhere: a passing script must never race a
 * short deadline on a loaded CI runner, where a cold `node` start alone can
 * take a while. Only the test that proves the bound shortens it.
 */
const PROBE = {};

/** Short enough that a hanging hook costs a test, not a suite. */
const SHORT_PROBE = { hooks: { timeoutMs: 700 } };

async function initializedRepo(
  packs: string[] = ["core"],
  seed?: (dir: string) => Promise<void>,
): Promise<string> {
  const dir = await makeTempDir("promised");
  if (seed !== undefined) {
    await seed(dir);
  }
  await runInit(dir, initAnswers({ packs }), { dryRun: false });
  return dir;
}

/** Writes a hook script, then puts the registries back in step with it. */
async function addHookScript(
  dir: string,
  file: string,
  body: string,
): Promise<void> {
  await mkdir(join(dir, ".agents", "hooks"), { recursive: true });
  await writeFile(join(dir, ".agents", "hooks", file), body, "utf8");
  await runSync(dir, { dryRun: false });
}

function protocolViolations(
  violations: { path: string; rule: string; message: string }[],
): { path: string; rule: string; message: string }[] {
  return violations.filter((violation) =>
    violation.rule.startsWith("hook-protocol-"),
  );
}

/** Indexes `path` with git mode 120000 while the working tree keeps the file. */
async function indexAsSymlink(dir: string, path: string): Promise<void> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    dir,
    "hash-object",
    "-w",
    join(dir, ...path.split("/")),
  ]);
  await execFileAsync("git", [
    "-C",
    dir,
    "update-index",
    "--add",
    "--cacheinfo",
    `120000,${stdout.trim()},${path}`,
  ]);
}

describe("32 - hook script protocol (invariant 15)", () => {
  it("Given a hook script that answers an empty stdout and exits 0, When check runs, Then no protocol violation is reported", async () => {
    const dir = await initializedRepo();
    await addHookScript(dir, "pretooluse-quiet.mjs", "process.exit(0);\n");
    const result = await runCheck(dir, PROBE);
    expect(protocolViolations(result.violations)).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("Given a hook script that answers one JSON object, When check runs, Then the answer is accepted", async () => {
    const dir = await initializedRepo();
    await addHookScript(
      dir,
      "pretooluse-decides.mjs",
      "console.log(JSON.stringify({ continue: true }));\nprocess.exit(0);\n",
    );
    expect(protocolViolations((await runCheck(dir, PROBE)).violations)).toEqual(
      [],
    );
  });

  it("Given a hook script that blocks with exit 2, When check runs, Then the documented refusal is not a violation", async () => {
    const dir = await initializedRepo();
    await addHookScript(
      dir,
      "pretooluse-blocks.mjs",
      'console.error("blocked: the sample payload is refused");\nprocess.exit(2);\n',
    );
    expect(protocolViolations((await runCheck(dir, PROBE)).violations)).toEqual(
      [],
    );
  });

  it("Given a hook script that writes free text on stdout, When check runs, Then it fails naming the file and quoting the text", async () => {
    const dir = await initializedRepo();
    await addHookScript(
      dir,
      "pretooluse-chatty.mjs",
      'console.log("checking the tool call...");\nprocess.exit(0);\n',
    );
    const result = await runCheck(dir, PROBE);
    const violation = result.violations.find(
      (entry) => entry.rule === "hook-protocol-stdout",
    );
    expect(violation?.path).toBe(".agents/hooks/pretooluse-chatty.mjs");
    expect(violation?.message).toContain("checking the tool call...");
    expect(result.exitCode).toBe(1);
  });

  it("Given a hook script that crashes on the sample payload, When check runs, Then the undocumented exit code is reported with its stderr", async () => {
    const dir = await initializedRepo();
    await addHookScript(
      dir,
      "posttooluse-crashes.mjs",
      'throw new Error("no tool_response field");\n',
    );
    const result = await runCheck(dir, PROBE);
    const violation = result.violations.find(
      (entry) => entry.rule === "hook-protocol-exit",
    );
    expect(violation?.path).toBe(".agents/hooks/posttooluse-crashes.mjs");
    expect(violation?.message).toContain("exited with code 1");
    expect(result.exitCode).toBe(1);
  });

  it("Given a hook script that never returns, When check runs, Then it is bounded and reported instead of hanging", async () => {
    const dir = await initializedRepo();
    await addHookScript(
      dir,
      "stop-hangs.mjs",
      "setTimeout(() => process.exit(0), 600000);\n",
    );
    const started = Date.now();
    const result = await runCheck(dir, SHORT_PROBE);
    const violation = result.violations.find(
      (entry) => entry.rule === "hook-protocol-timeout",
    );
    expect(violation?.path).toBe(".agents/hooks/stop-hangs.mjs");
    expect(violation?.message).toContain("700 ms");
    expect(Date.now() - started).toBeLessThan(HOOK_PROBE_TIMEOUT_MS);
    expect(result.exitCode).toBe(1);
    // the bound is what is under test, so the test may not lean on the default
    // vitest budget to prove it — it gives the probe room and times it itself
  }, 20000);

  it("Given a hook script that reads stdin to the end, When check runs, Then the sample payload closes the stream instead of blocking it", async () => {
    const dir = await initializedRepo();
    await addHookScript(
      dir,
      "userpromptsubmit-reads.mjs",
      [
        'let raw = "";',
        "for await (const chunk of process.stdin) { raw += chunk; }",
        "const payload = JSON.parse(raw);",
        'if (payload.hook_event_name !== "UserPromptSubmit") { process.exit(1); }',
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    expect(protocolViolations((await runCheck(dir, PROBE)).violations)).toEqual(
      [],
    );
  });

  it("Given a script no event can be attributed to, When check runs, Then it is left alone — no harness runs it either", async () => {
    const dir = await initializedRepo();
    await addHookScript(
      dir,
      "zzz-user-owned.mjs",
      'console.log("free text");\nprocess.exit(3);\n',
    );
    const result = await runCheck(dir, PROBE);
    expect(protocolViolations(result.violations)).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});

describe("32 - symlink health, the git half (invariant 11)", () => {
  it("Given a projection indexed as a symlink but materialized as a text file, When check runs, Then it fails naming the path and the repair", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    await indexAsSymlink(dir, "CLAUDE.md");
    const result = await runCheck(dir, PROBE);
    const violation = result.violations.find(
      (entry) => entry.rule === "symlink-materialized",
    );
    expect(violation?.path).toBe("CLAUDE.md");
    // the repo projects in copy mode: telling it to switch to copy mode would
    // name the mode it is already in — the index is the half to repair
    expect(violation?.message).toContain("git add CLAUDE.md");
    expect(violation?.message).not.toContain("--mode copy");
    expect(result.exitCode).toBe(1);
  });

  it("Given a symlink-mode repo whose projection is already reported as replaced by a copy, When check runs, Then the same path is not reported twice", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    await indexAsSymlink(dir, "CLAUDE.md");
    const manifest = join(dir, ".agents.toml");
    await writeFile(
      manifest,
      (await readFile(manifest, "utf8")).replace(
        'mode = "copy"',
        'mode = "symlink"',
      ),
      "utf8",
    );
    const violations = (await runCheck(dir, PROBE)).violations.filter(
      (entry) => entry.path === "CLAUDE.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("projection-replaced-by-copy");
  });

  it("Given a file outside the projections indexed the same way, When check runs, Then the invariant stays within its scope", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    await writeFile(join(dir, "notes.md"), "AGENTS.md", "utf8");
    await indexAsSymlink(dir, "notes.md");
    const result = await runCheck(dir, PROBE);
    expect(
      result.violations.filter(
        (entry) => entry.rule === "symlink-materialized",
      ),
    ).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("Given a repository that is not a git repo, When check runs, Then the invariant is silent rather than failing", async () => {
    const dir = await initializedRepo();
    const result = await runCheck(dir, PROBE);
    expect(
      result.violations.filter(
        (entry) => entry.rule === "symlink-materialized",
      ),
    ).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});

describe("32 - the lock covers the generic rules and scripts a pack installs", () => {
  it("Given a pack installing a generic rule, When init writes it, Then the lock tracks the file with sourceType agentsdir", async () => {
    const dir = await initializedRepo(["core", "verification"]);
    const lock = JSON.parse(
      await readFile(join(dir, "skills-lock.json"), "utf8"),
    );
    expect(lock.files[".agents/rules/verification.md"]).toMatchObject({
      source: "agentsdir",
      sourceType: "agentsdir",
    });
    expect(lock.files[".agents/rules/verification.md"].computedHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("Given a pack added after init, When pack add writes its rule, Then the lock tracks it exactly as init would", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "verification", { dryRun: false });
    const lock = JSON.parse(
      await readFile(join(dir, "skills-lock.json"), "utf8"),
    );
    expect(lock.files[".agents/rules/verification.md"]).toMatchObject({
      source: "agentsdir",
      sourceType: "agentsdir",
    });
    expect((await runCheck(dir, PROBE)).exitCode).toBe(0);
  });

  it("Given a locked rule edited locally, When check runs, Then it is reported as information and never fails the check", async () => {
    const dir = await initializedRepo(["core", "verification"]);
    const rule = join(dir, ".agents", "rules", "verification.md");
    await writeFile(
      rule,
      `${await readFile(rule, "utf8")}\nA line the user added.\n`,
      "utf8",
    );
    await runSync(dir, { dryRun: false });
    const result = await runCheck(dir, PROBE);
    const violation = result.violations.find(
      (entry) => entry.path === ".agents/rules/verification.md",
    );
    expect(violation?.rule).toBe("lock-local-change");
    expect(violation?.severity).toBe("info");
    expect(result.exitCode).toBe(0);
  });

  it("Given a locked script removed from the repo, When check runs, Then the missing file is an error naming it", async () => {
    const dir = await initializedRepo(["core", "worktrees"]);
    await rm(
      join(dir, ".agents", "scripts", "worktrees", "worktree-setup.mjs"),
    );
    const result = await runCheck(dir, PROBE);
    const violation = result.violations.find(
      (entry) => entry.rule === "lock-file-missing",
    );
    expect(violation?.path).toBe(
      ".agents/scripts/worktrees/worktree-setup.mjs",
    );
    expect(result.exitCode).toBe(1);
  });

  it("Given a lock whose files key escapes the repository, When check runs, Then it is refused before anything is read", async () => {
    const dir = await initializedRepo(["core", "verification"]);
    const lockPath = join(dir, "skills-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.files = { "../../outside.md": { computedHash: "0".repeat(64) } };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    const result = await runCheck(dir, PROBE);
    const violation = result.violations.find(
      (entry) => entry.rule === "lock-invalid",
    );
    expect(violation?.message).toContain("../../outside.md");
    expect(result.exitCode).toBe(1);
  });

  it("Given a rule the repo already had, When init keeps it, Then it gets no lock entry and check reports no local change", async () => {
    const pack = getPackContent("verification");
    const packRule =
      pack?.files.find((file) => file.path === ".agents/rules/verification.md")
        ?.content ?? "";
    // same opening lines, so the rules index still describes the file on disk;
    // only the body differs, which is what the lock would fingerprint
    const kept = `${packRule.split("\n").slice(0, 3).join("\n")}\n\nThe rule this repository already had.\n`;
    const dir = await initializedRepo(
      ["core", "verification"],
      async (root) => {
        await mkdir(join(root, ".agents", "rules"), { recursive: true });
        await writeFile(
          join(root, ".agents", "rules", "verification.md"),
          kept,
          "utf8",
        );
      },
    );
    const lock = JSON.parse(
      await readFile(join(dir, "skills-lock.json"), "utf8"),
    );
    expect(lock.files?.[".agents/rules/verification.md"]).toBeUndefined();
    expect(
      await readFile(join(dir, ".agents", "rules", "verification.md"), "utf8"),
    ).toBe(kept);
    expect(
      (await runCheck(dir, PROBE)).violations.filter(
        (entry) => entry.rule === "lock-local-change",
      ),
    ).toEqual([]);
  });

  it("Given a pack removed, When its lock entries go, Then no locked file is left pointing at a deleted rule", async () => {
    const dir = await initializedRepo(["core", "creator", "verification"]);
    await runPackRemove(dir, "verification", { force: false, dryRun: false });
    const lock = JSON.parse(
      await readFile(join(dir, "skills-lock.json"), "utf8"),
    );
    expect(lock.files?.[".agents/rules/verification.md"]).toBeUndefined();
    // the meta-skills stay locked: only the removed pack's entries leave
    expect(lock.skills["create-skill"]).toBeDefined();
    expect((await runCheck(dir, PROBE)).exitCode).toBe(0);
  });
});
