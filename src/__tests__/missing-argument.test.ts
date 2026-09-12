import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineCommand } from "citty";
import { describe, expect, it } from "vitest";
import { missingArgument } from "../command-tree.js";
import { EXIT_CODES } from "../exit-codes.js";
import { makeTempDir, runCli } from "../test-support/index.js";

const execFileAsync = promisify(execFile);

/**
 * A required argument left out is a usage error, not drift. Left to citty it
 * prints the help and exits 1 — the code a CI script reads as "the repository
 * moved" — while the caller simply mistyped the command (`docs/commandes.md`
 * fixes 1 = drift, 2 = usage precisely so the two can be told apart).
 */
const COMMANDS: { argv: string[]; argument: string }[] = [
  { argv: ["add", "skill"], argument: "<name>" },
  { argv: ["add", "rule"], argument: "<name>" },
  { argv: ["add", "agent"], argument: "<name>" },
  { argv: ["add", "hook"], argument: "<event>" },
  { argv: ["pack", "add"], argument: "<name>" },
  { argv: ["pack", "remove"], argument: "<name>" },
];

/** A tree shaped like the real one, to exercise the resolution off the CLI. */
const tree = defineCommand({
  meta: { name: "agentsdir" },
  subCommands: {
    add: defineCommand({
      meta: { name: "add" },
      subCommands: {
        hook: defineCommand({
          meta: { name: "hook" },
          args: {
            event: { type: "positional", required: true },
            name: { type: "string" },
            json: { type: "boolean" },
          },
        }),
      },
    }),
    check: defineCommand({ meta: { name: "check" }, args: {} }),
  },
});

describe("35 - a missing required argument", () => {
  it.each(COMMANDS)(
    "Given `$argv` run without its required argument, When the CLI runs it, Then it exits 2 (usage), never 1 (drift)",
    async ({ argv, argument }) => {
      const dir = await makeTempDir("missing-argument");
      await execFileAsync("git", ["-C", dir, "init"]);

      const { code, stderr } = await runCli(dir, argv);

      expect(code).toBe(EXIT_CODES.environmentOrUsage);
      expect(stderr).toContain(`Missing required argument ${argument}`);
      expect(stderr).toContain(`agentsdir ${argv.join(" ")}`);
    },
  );

  it("Given the argument is present, When the argv is inspected, Then nothing is reported", () => {
    for (const argv of [
      ["add", "hook", "PreToolUse"],
      ["add", "hook", "PreToolUse", "--name", "guard"],
      ["add", "hook", "--name", "guard", "PreToolUse"],
      ["check"],
      ["check", "--json"],
      [],
      ["add"],
    ]) {
      expect(missingArgument(tree, argv), argv.join(" ")).toBeUndefined();
    }
  });

  it("Given an option value standing where the argument would be, When the argv is inspected, Then the argument still counts as missing", () => {
    // read naively, `--name guard` offers "guard" as the event and hides that
    // the required one was never given
    expect(missingArgument(tree, ["add", "hook", "--name", "guard"])).toContain(
      "Missing required argument <event>",
    );
    expect(missingArgument(tree, ["add", "hook", "--name=guard"])).toContain(
      "Missing required argument <event>",
    );
  });

  it("Given `--help` on a command with a required argument, When the argv is inspected, Then the help is left to print", () => {
    expect(missingArgument(tree, ["add", "hook", "--help"])).toBeUndefined();
    expect(missingArgument(tree, ["add", "hook", "-h"])).toBeUndefined();
  });
});
