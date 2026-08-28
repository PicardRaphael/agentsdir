#!/usr/bin/env node
import { defineCommand, runMain, showUsage } from "citty";

const main = defineCommand({
  meta: {
    name: "agentsdir",
    version: "0.0.0",
    description:
      "Install an agent configuration architecture based on open standards (AGENTS.md, Agent Skills) into an existing repo.",
  },
  async run() {
    await showUsage(main);
  },
});

await runMain(main);
