import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../exit-codes.js";
import { makeTempDir, runCli } from "../../test-support/index.js";

const execFileAsync = promisify(execFile);

/**
 * `docs/commandes.md` promises that `--json` writes a single object
 * `{command, mode, changes, errors, exitCode}` on stdout. The branch holding
 * that promise when a command fails existed in five copies and was asserted
 * nowhere — while failure is precisely the case a script is written for: a
 * human sentence on stdout crashes the parser that reads it.
 */
interface JsonReport {
  command: string;
  mode: string | null;
  changes: unknown[];
  errors: { message: string; severity: string }[];
  exitCode: number;
}

/** A git repo with no `.agents.toml`: reading the manifest fails with exit 2. */
async function gitRepoWithoutManifest(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await execFileAsync("git", ["-C", dir, "init"]);
  return dir;
}

/**
 * A directory git refuses to resolve: `.git` is a file in the gitfile position
 * but holds no `gitdir:` line. Preferred over "a directory that happens not to
 * be a repository", which depends on where the temp directory lives.
 */
async function unresolvableRepo(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await writeFile(join(dir, ".git"), "not a gitfile\n", "utf8");
  return dir;
}

/** The whole contract in one place: parse stdout, and nothing but stdout. */
async function expectSingleJsonFailure(
  dir: string,
  argv: string[],
  command: string,
): Promise<void> {
  const { stdout, code } = await runCli(dir, argv);

  expect(code).toBe(EXIT_CODES.environmentOrUsage);
  // a script parses stdout whole: one line, one object, no human sentence
  expect(stdout.trimEnd().split("\n")).toHaveLength(1);
  const report = JSON.parse(stdout) as JsonReport;
  expect(report.command).toBe(command);
  expect(report.mode).toBeNull();
  expect(report.changes).toEqual([]);
  expect(report.errors.length).toBeGreaterThan(0);
  expect(report.errors[0]?.severity).toBe("error");
  expect(report.errors[0]?.message).not.toBe("");
  expect(report.exitCode).toBe(EXIT_CODES.environmentOrUsage);
}

interface FailureCase {
  /** Value of the `command` field the report must carry. */
  command: string;
  argv: string[];
  makeRepo: (prefix: string) => Promise<string>;
  /** What makes this invocation fail, for the test name. */
  because: string;
}

const FAILURE_CASES: FailureCase[] = [
  {
    command: "check",
    argv: ["check", "--json"],
    makeRepo: gitRepoWithoutManifest,
    because: "the manifest is missing",
  },
  {
    command: "sync",
    argv: ["sync", "--json"],
    makeRepo: gitRepoWithoutManifest,
    because: "the manifest is missing",
  },
  {
    command: "doctor",
    argv: ["doctor", "--json"],
    makeRepo: unresolvableRepo,
    because: "the repository root cannot be resolved",
  },
  {
    command: "add skill",
    argv: ["add", "skill", "Bad_Name", "--json"],
    makeRepo: gitRepoWithoutManifest,
    because: "the name is not kebab-case",
  },
  {
    command: "add rule",
    argv: ["add", "rule", "Bad_Name", "--json"],
    makeRepo: gitRepoWithoutManifest,
    because: "the name is not kebab-case",
  },
  {
    command: "add agent",
    argv: ["add", "agent", "Bad_Name", "--json"],
    makeRepo: gitRepoWithoutManifest,
    because: "the name is not kebab-case",
  },
  {
    command: "add hook",
    argv: ["add", "hook", "PreToolUse", "--name", "Bad_Name", "--json"],
    makeRepo: gitRepoWithoutManifest,
    because: "the slug is not kebab-case",
  },
  {
    command: "pack add",
    argv: ["pack", "add", "nope", "--json"],
    makeRepo: gitRepoWithoutManifest,
    because: "the pack does not exist",
  },
  {
    command: "pack remove",
    argv: ["pack", "remove", "nope", "--json"],
    makeRepo: gitRepoWithoutManifest,
    because: "the pack does not exist",
  },
];

describe("36 - the --json contract when a command fails", () => {
  it.each(FAILURE_CASES)(
    "Given `$command --json` failing because $because, When it runs, Then stdout carries one parsable object with a non-empty errors[] and exit code 2",
    async ({ command, argv, makeRepo }) => {
      const dir = await makeRepo(`json-failure-${command.replace(" ", "-")}`);

      await expectSingleJsonFailure(dir, argv, command);
    },
  );

  it("Given the same failure without --json, When it runs, Then the message goes to stderr and stdout stays empty", async () => {
    // the counterpart of the contract: a script that forgets --json must not
    // find half an object on stdout either
    const dir = await gitRepoWithoutManifest("json-failure-human");

    const { stdout, stderr, code } = await runCli(dir, ["check"]);

    expect(code).toBe(EXIT_CODES.environmentOrUsage);
    expect(stdout).toBe("");
    expect(stderr).toContain("agentsdir init");
  });
});
