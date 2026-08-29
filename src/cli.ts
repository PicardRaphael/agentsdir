#!/usr/bin/env node
import { defineCommand, runMain, showUsage } from "citty";
import { addAgentCommand } from "./commands/add-agent.js";
import { addHookCommand } from "./commands/add-hook.js";
import { addRuleCommand } from "./commands/add-rule.js";
import { addSkillCommand } from "./commands/add-skill.js";
import { checkCommand } from "./commands/check.js";
import { initCommand } from "./commands/init.js";
import { packAddCommand, packRemoveCommand } from "./commands/pack.js";
import { syncCommand } from "./commands/sync.js";
import { CLI_VERSION } from "./version.js";

const packCommand = defineCommand({
  meta: {
    name: "pack",
    description: "Install or remove content packs (verification, changelog, …)",
  },
  subCommands: {
    add: packAddCommand,
    remove: packRemoveCommand,
  },
  async run({ args }) {
    // citty also runs the group command when a subcommand matched
    if (args._.length === 0) {
      await showUsage(packCommand);
    }
  },
});

const addCommand = defineCommand({
  meta: {
    name: "add",
    description:
      "Generators: create a skill, rule or agent in the source of truth",
  },
  subCommands: {
    skill: addSkillCommand,
    rule: addRuleCommand,
    agent: addAgentCommand,
    hook: addHookCommand,
  },
  async run({ args }) {
    // citty also runs the group command when a subcommand matched
    if (args._.length === 0) {
      await showUsage(addCommand);
    }
  },
});

const main = defineCommand({
  meta: {
    name: "agentsdir",
    version: CLI_VERSION,
    description:
      "Install an agent configuration architecture based on open standards (AGENTS.md, Agent Skills) into an existing repo.",
  },
  subCommands: {
    init: initCommand,
    add: addCommand,
    pack: packCommand,
    sync: syncCommand,
    check: checkCommand,
  },
  async run({ args }) {
    // citty also runs the root command when a subcommand matched
    if (args._.length === 0) {
      await showUsage(main);
    }
  },
});

await runMain(main);
