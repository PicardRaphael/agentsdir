import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initAnswers, makeTempDir, runCli } from "../../test-support/index.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { runInit } from "../init.js";

const execFileAsync = promisify(execFile);

/**
 * The generators refuse before they ask. Answering six questions to *then* be
 * told the name is taken — or that the repository was never initialized — is
 * the first thing someone meets when they install, and the interview running
 * ahead of the guard rails is what made it happen.
 *
 * The probe is the non-TTY notice each interview prints on entry: seeing it
 * proves the interview started, and its absence proves the refusal came first.
 */
const GENERATORS: { command: string; argv: string[]; taken: string[] }[] = [
  {
    command: "add skill",
    argv: ["add", "skill", "demo-skill"],
    taken: ["add", "skill", "demo-skill"],
  },
  {
    command: "add rule",
    argv: ["add", "rule", "demo-rule"],
    taken: ["add", "rule", "demo-rule"],
  },
  {
    command: "add agent",
    argv: ["add", "agent", "demo-agent"],
    taken: ["add", "agent", "demo-agent"],
  },
];

async function initializedRepo(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  // the CLI resolves its root from git, so the scratch repo needs one
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

describe("35 - the refusal comes before the first question", () => {
  it.each(GENERATORS)(
    "Given a name already taken, When `$command` runs, Then it refuses without starting the interview",
    async ({ argv, taken }) => {
      const dir = await initializedRepo("generator-guards-taken");
      const first = await runCli(dir, taken);
      expect(first.code).toBe(EXIT_CODES.ok);

      const { code, stderr } = await runCli(dir, argv);

      expect(code).toBe(EXIT_CODES.environmentOrUsage);
      expect(stderr).toContain("already exists");
      expect(stderr).not.toContain("not a TTY");
    },
  );

  it.each(GENERATORS)(
    "Given a repo with no manifest, When `$command` runs, Then it refuses without starting the interview",
    async ({ argv }) => {
      const dir = await makeTempDir("generator-guards-manifest");
      await execFileAsync("git", ["-C", dir, "init"]);

      const { code, stderr } = await runCli(dir, argv);

      expect(code).toBe(EXIT_CODES.environmentOrUsage);
      expect(stderr).toContain("agentsdir init");
      expect(stderr).not.toContain("not a TTY");
    },
  );

  it("Given a free name in an initialized repo, When add skill runs, Then the interview is reached", async () => {
    // the counterpart: the guard rails must not swallow the interview itself
    const dir = await initializedRepo("generator-guards-free");

    const { code, stderr } = await runCli(dir, ["add", "skill", "free-name"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(stderr).toContain("not a TTY");
  });
});
