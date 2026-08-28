#!/usr/bin/env node
import { defineCommand, runMain, showUsage } from "citty";
import { checkCommand } from "./commands/check.js";
import { initCommand } from "./commands/init.js";
import { syncCommand } from "./commands/sync.js";
import { CLI_VERSION } from "./version.js";

const main = defineCommand({
  meta: {
    name: "agentsdir",
    version: CLI_VERSION,
    description:
      "Install an agent configuration architecture based on open standards (AGENTS.md, Agent Skills) into an existing repo.",
  },
  subCommands: {
    init: initCommand,
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
