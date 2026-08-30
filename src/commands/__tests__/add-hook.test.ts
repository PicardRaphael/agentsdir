import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CliError } from "../../core/errors.js";
import {
  parseHookMetadata,
  resolveHookEvent,
} from "../../core/hook-registries.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
  runCli,
} from "../../test-support/index.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runSync } from "../sync.js";
import { resolveHookEventOrFail, runAddHook } from "../add-hook.js";

const execFileAsync = promisify(execFile);
const registriesSource = fileURLToPath(
  new URL("../../core/hook-registries.ts", import.meta.url),
);

async function initializedRepo(): Promise<string> {
  const dir = await makeTempDir("add-hook");
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

function preToolUse(): {
  event: NonNullable<ReturnType<typeof resolveHookEvent>>;
} {
  const event = resolveHookEvent("PreToolUse");
  if (event === undefined) {
    throw new Error("PreToolUse missing from the matrix");
  }
  return { event };
}

async function readJson(root: string, path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, ...path.split("/")), "utf8"));
}

const OUR_COMMAND = "node .agents/hooks/pretooluse-guard.mjs";

/** Non-trivial pre-existing registries: user hooks under our event and others. */
async function seedUserRegistries(root: string): Promise<void> {
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(
    join(root, ".claude", "settings.json"),
    `${JSON.stringify(
      {
        permissions: { allow: ["Bash(npm test)"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "Write",
              hooks: [{ type: "command", command: "./my-guard.sh" }],
            },
          ],
          SessionStart: [
            { hooks: [{ type: "command", command: "./greet.sh" }] },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(
    join(root, ".codex", "hooks.json"),
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "./codex-guard.sh" }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await mkdir(join(root, ".cursor"), { recursive: true });
  await writeFile(
    join(root, ".cursor", "hooks.json"),
    `${JSON.stringify(
      {
        version: 1,
        hooks: {
          preToolUse: [{ command: "./cursor-guard.sh", matcher: "Shell" }],
          beforeShellExecution: [{ command: "./shell-audit.sh" }],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("10 - add hook", () => {
  it("Given a common event, When add hook runs, Then the portable script is created and registered on claude, codex and cursor in their exact formats", async () => {
    const dir = await initializedRepo();
    const result = await runAddHook(
      dir,
      { ...preToolUse(), slug: "guard", matcher: "Bash" },
      { dryRun: false },
    );
    expect(result.exitCode).toBe(0);
    const script = await readFile(
      join(dir, ".agents", "hooks", "pretooluse-guard.mjs"),
      "utf8",
    );
    expect(script).toContain(
      '// agentsdir:hook {"event":"PreToolUse","matcher":"Bash"}',
    );
    expect(script).toContain("process.stdin");
    expect(parseHookMetadata(script)?.event.name).toBe("PreToolUse");
    expect(await readJson(dir, ".claude/settings.json")).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: OUR_COMMAND }],
          },
        ],
      },
    });
    expect(await readJson(dir, ".codex/hooks.json")).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: OUR_COMMAND }],
          },
        ],
      },
    });
    expect(await readJson(dir, ".cursor/hooks.json")).toEqual({
      version: 1,
      hooks: { preToolUse: [{ command: OUR_COMMAND }] },
    });
    expect(result.warnings.some((w) => w.includes("Cursor"))).toBe(true);
  });

  it("Given pre-existing non-trivial registries with user hooks under the same event, When add hook runs, Then user entries survive and ours are merged", async () => {
    const dir = await initializedRepo();
    await seedUserRegistries(dir);
    await runAddHook(
      dir,
      { ...preToolUse(), slug: "guard", matcher: "Bash" },
      { dryRun: false },
    );
    const claude = (await readJson(dir, ".claude/settings.json")) as {
      permissions: unknown;
      hooks: Record<string, unknown[]>;
    };
    expect(claude.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(claude.hooks["SessionStart"]).toEqual([
      { hooks: [{ type: "command", command: "./greet.sh" }] },
    ]);
    expect(claude.hooks["PreToolUse"]).toEqual([
      {
        matcher: "Write",
        hooks: [{ type: "command", command: "./my-guard.sh" }],
      },
      { matcher: "Bash", hooks: [{ type: "command", command: OUR_COMMAND }] },
    ]);
    const codex = (await readJson(dir, ".codex/hooks.json")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(codex.hooks["PreToolUse"]).toHaveLength(2);
    expect(codex.hooks["PreToolUse"]?.[0]).toEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: "./codex-guard.sh" }],
    });
    const cursor = (await readJson(dir, ".cursor/hooks.json")) as {
      version: number;
      hooks: Record<string, unknown[]>;
    };
    expect(cursor.version).toBe(1);
    expect(cursor.hooks["beforeShellExecution"]).toEqual([
      { command: "./shell-audit.sh" },
    ]);
    expect(cursor.hooks["preToolUse"]).toEqual([
      { command: "./cursor-guard.sh", matcher: "Shell" },
      { command: OUR_COMMAND },
    ]);
  });

  it("Given the script deleted by hand, When sync runs, Then the orphan registrations are removed and user entries of the same event survive", async () => {
    const dir = await initializedRepo();
    await seedUserRegistries(dir);
    await runAddHook(
      dir,
      { ...preToolUse(), slug: "guard", matcher: "Bash" },
      { dryRun: false },
    );
    await unlink(join(dir, ".agents", "hooks", "pretooluse-guard.mjs"));
    const sync = await runSync(dir, { dryRun: false });
    expect(sync.exitCode).toBe(0);
    const claude = (await readJson(dir, ".claude/settings.json")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(JSON.stringify(claude)).not.toContain(OUR_COMMAND);
    expect(claude.hooks["PreToolUse"]).toEqual([
      {
        matcher: "Write",
        hooks: [{ type: "command", command: "./my-guard.sh" }],
      },
    ]);
    const codex = (await readJson(dir, ".codex/hooks.json")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(JSON.stringify(codex)).not.toContain(OUR_COMMAND);
    expect(codex.hooks["PreToolUse"]).toHaveLength(1);
    const cursor = (await readJson(dir, ".cursor/hooks.json")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(JSON.stringify(cursor)).not.toContain(OUR_COMMAND);
    expect(cursor.hooks["preToolUse"]).toEqual([
      { command: "./cursor-guard.sh", matcher: "Shell" },
    ]);
  });

  it("Given add hook completed, When sync runs right after, Then the three registries are reported ok (add hook and sync render the same bytes)", async () => {
    const dir = await initializedRepo();
    await runAddHook(
      dir,
      { ...preToolUse(), slug: "guard", matcher: "Bash" },
      { dryRun: false },
    );
    const sync = await runSync(dir, { dryRun: true });
    expect(sync.exitCode).toBe(0);
    for (const path of [
      ".claude/settings.json",
      ".codex/hooks.json",
      ".cursor/hooks.json",
    ]) {
      const change = sync.changes.find((entry) => entry.path === path);
      expect(change?.action).toBe("ok");
    }
    const check = await runCheck(dir);
    expect(check.exitCode).toBe(0);
  });

  it("Given a user group that already references our script, When sync runs, Then no duplicate registration is added", async () => {
    const dir = await initializedRepo();
    await runAddHook(
      dir,
      { ...preToolUse(), slug: "guard", matcher: "Bash" },
      { dryRun: false },
    );
    // the user merges our command into their own multi-handler group
    await writeFile(
      join(dir, ".claude", "settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  { type: "command", command: "./their-first.sh" },
                  { type: "command", command: OUR_COMMAND },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const sync = await runSync(dir, { dryRun: false });
    expect(sync.exitCode).toBe(0);
    const claude = (await readJson(dir, ".claude/settings.json")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(claude.hooks["PreToolUse"]).toHaveLength(1);
    const occurrences = JSON.stringify(claude).split(OUR_COMMAND).length - 1;
    expect(occurrences).toBe(1);
  });

  it("Given an unknown event, When add hook runs, Then it exits 2 listing the known events", () => {
    let error: unknown;
    try {
      resolveHookEventOrFail("OnRandomThing");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    expect((error as CliError).message).toContain("PreToolUse");
    expect(resolveHookEventOrFail("pretooluse").name).toBe("PreToolUse");
  });

  it("Given the script name already taken, When add hook runs again, Then it exits 2 and the registries are untouched", async () => {
    const dir = await initializedRepo();
    await runAddHook(
      dir,
      { ...preToolUse(), slug: "guard", matcher: "Bash" },
      { dryRun: false },
    );
    const before = await readFile(
      join(dir, ".claude", "settings.json"),
      "utf8",
    );
    let error: unknown;
    try {
      await runAddHook(
        dir,
        { ...preToolUse(), slug: "guard", matcher: "Write" },
        { dryRun: false },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    expect(await readFile(join(dir, ".claude", "settings.json"), "utf8")).toBe(
      before,
    );
  });

  it("Given --dry-run, When add hook runs, Then nothing is written and the plan and exit code equal the real run", async () => {
    const dir = await initializedRepo();
    const dry = await runAddHook(
      dir,
      { ...preToolUse(), slug: "guard", matcher: "Bash" },
      { dryRun: true },
    );
    expect(dry.exitCode).toBe(0);
    expect(dry.changes.map((change) => change.path)).toEqual([
      ".agents/hooks/pretooluse-guard.mjs",
      ".claude/settings.json",
      ".codex/hooks.json",
      ".cursor/hooks.json",
    ]);
    expect(
      await pathExists(join(dir, ".agents", "hooks", "pretooluse-guard.mjs")),
    ).toBe(false);
    expect(await pathExists(join(dir, ".claude", "settings.json"))).toBe(false);
    const real = await runAddHook(
      dir,
      { ...preToolUse(), slug: "guard", matcher: "Bash" },
      { dryRun: false },
    );
    expect(real.exitCode).toBe(dry.exitCode);
    expect(real.changes).toEqual(dry.changes);
  });

  it("Given an event unsupported by one harness, When add hook runs, Then that registry is not created and a warning names the gap", async () => {
    const dir = await initializedRepo();
    const event = resolveHookEvent("PostCompact");
    expect(event).toBeDefined();
    if (event === undefined) {
      return;
    }
    const result = await runAddHook(
      dir,
      { event, slug: "audit", matcher: undefined },
      { dryRun: false },
    );
    expect(result.exitCode).toBe(0);
    expect(await pathExists(join(dir, ".cursor", "hooks.json"))).toBe(false);
    expect(await pathExists(join(dir, ".claude", "settings.json"))).toBe(true);
    expect(await pathExists(join(dir, ".codex", "hooks.json"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("cursor"))).toBe(true);
  });

  it("Given the registration matrix, When inspected, Then it carries a source comment and a last-validated date", async () => {
    const source = await readFile(registriesSource, "utf8");
    expect(source).toContain("docs/harness.md");
    expect(source).toMatch(/Last validated: \d{4}-\d{2}-\d{2}/);
  });

  it("Given a non-TTY terminal, When the CLI runs add hook --json, Then stdout is one machine object and the script exists", async () => {
    const dir = await initializedRepo();
    await execFileAsync("git", ["-C", dir, "init"]);
    const { code, stdout } = await runCli(dir, [
      "add",
      "hook",
      "PreToolUse",
      "--name",
      "guard",
      "--matcher",
      "Bash",
      "--json",
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      command: string;
      changes: { path: string }[];
      exitCode: number;
    };
    expect(report.command).toBe("add hook");
    expect(report.exitCode).toBe(0);
    expect(
      await pathExists(join(dir, ".agents", "hooks", "pretooluse-guard.mjs")),
    ).toBe(true);
  });
});
