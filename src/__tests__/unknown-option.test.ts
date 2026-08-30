import { defineCommand } from "citty";
import { describe, expect, it } from "vitest";
import { unknownOption } from "../command-tree.js";
import { addSkillCommand } from "../commands/add-skill.js";
import { checkCommand } from "../commands/check.js";
import { initCommand } from "../commands/init.js";
import { packAddCommand } from "../commands/pack.js";

const addGroup = defineCommand({
  meta: { name: "add" },
  subCommands: { skill: addSkillCommand },
});

const packGroup = defineCommand({
  meta: { name: "pack" },
  subCommands: { add: packAddCommand },
});

const main = defineCommand({
  meta: { name: "agentsdir" },
  subCommands: {
    init: initCommand,
    check: checkCommand,
    add: addGroup,
    pack: packGroup,
  },
});

/**
 * citty ignores options nobody declared, so `init --dryrun` used to install the
 * whole architecture and exit 0 while the user believed they were simulating.
 * The declared names are read from the command definitions, never duplicated.
 */
describe("cli - an option no command declares is a usage error", () => {
  it("Given a typo on --dry-run, When the CLI parses it, Then it is refused by name instead of running for real", () => {
    const message = unknownOption(main, ["init", "--yes", "--dryrun"]);
    expect(message).toContain('Unknown option "--dryrun"');
    expect(message).toContain("--dry-run");
  });

  it("Given the options a command really declares, When they are passed, Then nothing is refused", () => {
    expect(
      unknownOption(main, [
        "init",
        "--yes",
        "--name",
        "demo",
        "--description",
        "d",
        "--mode",
        "copy",
      ]),
    ).toBeUndefined();
    expect(unknownOption(main, ["check", "--json"])).toBeUndefined();
  });

  it("Given a nested subcommand, When its own options are used, Then they are resolved against that subcommand", () => {
    expect(
      unknownOption(main, ["add", "skill", "my-proc", "--dry-run"]),
    ).toBeUndefined();
    expect(
      unknownOption(main, ["pack", "add", "verification", "--json"]),
    ).toBeUndefined();
    // --paths belongs to `add rule`, not to `add skill`
    expect(
      unknownOption(main, ["add", "skill", "x", "--paths", "src/**"]),
    ).toContain('Unknown option "--paths"');
  });

  it("Given --help or --version, When they are passed anywhere, Then they are accepted without being declared", () => {
    expect(unknownOption(main, ["--help"])).toBeUndefined();
    expect(unknownOption(main, ["--version"])).toBeUndefined();
    expect(unknownOption(main, ["add", "skill", "--help"])).toBeUndefined();
  });

  it("Given the negated form of a declared boolean, When it is passed, Then it is accepted", () => {
    expect(unknownOption(main, ["init", "--no-yes"])).toBeUndefined();
  });

  it("Given an option written with an equals sign, When it is unknown, Then it is still caught", () => {
    expect(unknownOption(main, ["init", "--mode=copy"])).toBeUndefined();
    expect(unknownOption(main, ["init", "--moode=copy"])).toContain(
      'Unknown option "--moode"',
    );
  });

  it("Given arguments after --, When they contain dashes, Then they are left alone", () => {
    expect(unknownOption(main, ["check", "--", "--not-ours"])).toBeUndefined();
  });
});
