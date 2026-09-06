import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { unknownCommand } from "../command-tree.js";
import { EXIT_CODES } from "../exit-codes.js";
import { makeTempDir, runCli } from "../test-support/index.js";

const execFileAsync = promisify(execFile);

/**
 * A typo is a usage error, not drift. Left to citty it would print the help and
 * exit 1 — the code a CI script reads as "the repo drifted" — so the exit code
 * of a mistyped command is part of the contract (`docs/commandes.md`).
 */
describe("cli - unknown commands", () => {
  it("Given a known command, When the argv is inspected, Then nothing is reported", () => {
    for (const argv of [
      [],
      ["--version"],
      ["check"],
      ["check", "--json"],
      ["add"],
      ["add", "skill", "my-skill"],
      ["pack", "add", "changelog"],
      ["--help"],
    ]) {
      expect(unknownCommand(argv), argv.join(" ")).toBeUndefined();
    }
  });

  it("Given a mistyped command, When the argv is inspected, Then the message names it and lists the alternatives", () => {
    expect(unknownCommand(["sinc"])).toBe(
      'Unknown command "sinc" (available: init, add, pack, sync, check, update, doctor).',
    );
    expect(unknownCommand(["add", "skil"])).toContain(
      'Unknown command "add skil"',
    );
    expect(unknownCommand(["pack", "instal"])).toContain(
      "available: pack add, pack remove",
    );
  });

  it("Given a mistyped command, When the CLI runs it, Then it exits 2 (usage), never 1 (drift)", async () => {
    const dir = await makeTempDir("unknown");
    await execFileAsync("git", ["-C", dir, "init"]);
    for (const args of [["sinc"], ["add", "skil"], ["pack", "instal"]]) {
      const { code, stderr } = await runCli(dir, args);
      expect(code, args.join(" ")).toBe(EXIT_CODES.environmentOrUsage);
      expect(stderr).toContain("Unknown command");
    }
  });
});
