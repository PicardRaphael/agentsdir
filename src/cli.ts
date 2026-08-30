#!/usr/bin/env node
import { defineCommand, runMain, showUsage, type CommandDef } from "citty";
import { addAgentCommand } from "./commands/add-agent.js";
import { addHookCommand } from "./commands/add-hook.js";
import { addRuleCommand } from "./commands/add-rule.js";
import { addSkillCommand } from "./commands/add-skill.js";
import { checkCommand } from "./commands/check.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { packAddCommand, packRemoveCommand } from "./commands/pack.js";
import { syncCommand } from "./commands/sync.js";
import { unknownCommand } from "./command-tree.js";
import { EXIT_CODES } from "./exit-codes.js";
import { CLI_VERSION } from "./version.js";

async function usageOrUnknown(
  group: CommandDef,
  positionals: string[],
): Promise<void> {
  if (positionals.length === 0) {
    await showUsage(group);
  }
}

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
    await usageOrUnknown(packCommand, args._);
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
    await usageOrUnknown(addCommand, args._);
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
    doctor: doctorCommand,
  },
  async run({ args }) {
    await usageOrUnknown(main, args._);
  },
});

const unknown = unknownCommand(process.argv.slice(2));
if (unknown === undefined) {
  await runMain(main);
} else {
  console.error(unknown);
  process.exit(EXIT_CODES.environmentOrUsage);
}
