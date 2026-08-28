import { renderBlock } from "../core/managed-blocks.js";

export interface AgentsMdInput {
  productName: string;
  description: string;
  stacks: string[];
  commands: { dev?: string; test?: string; lint?: string };
}

/** Content of the `rules-index` managed block (markers excluded). */
export function renderRulesIndexContent(): string {
  return [
    "Read the matching rule before touching the files it covers:",
    "",
    "- `.agents/rules/tasks.md` — before taking any task from `.agents/tasks/`.",
    "- `.agents/rules/memory.md` — before reading or writing `.agents/memory/`.",
  ].join("\n");
}

/**
 * Full AGENTS.md for a repo that has none. Three families of sections:
 * product (interview answers), stack (detection), generic (working rules and
 * the managed rules index).
 */
export function renderAgentsMd(input: AgentsMdInput): string {
  const description =
    input.description === ""
      ? "_One-sentence description to fill in._"
      : input.description;
  const stackLine =
    input.stacks.length > 0
      ? `Detected stacks: ${input.stacks.map((stack) => `\`${stack}\``).join(", ")}.`
      : "No stack detected yet — document it here.";
  const rows: [string, string | undefined][] = [
    ["dev", input.commands.dev],
    ["test", input.commands.test],
    ["lint", input.commands.lint],
  ];
  const commandRows = rows
    .filter(
      (row): row is [string, string] => row[1] !== undefined && row[1] !== "",
    )
    .map(([action, command]) => `| ${action} | \`${command}\` |`);
  const commandsSection =
    commandRows.length > 0
      ? ["| Action | Command |", "| --- | --- |", ...commandRows].join("\n")
      : "Document the dev, test and lint commands here.";
  return [
    "# AGENTS.md",
    "",
    "Entry point for AI agents working on this repo. Every section belongs to the team",
    "except the managed blocks (`agentsdir:begin` / `agentsdir:end`), which agentsdir",
    "regenerates — edit everything else freely.",
    "",
    "## Product",
    "",
    `**${input.productName}** — ${description}`,
    "",
    "## Stack",
    "",
    stackLine,
    "",
    commandsSection,
    "",
    "## Working rules",
    "",
    "- A change is done when the commands above pass and the impacted documents are",
    "  updated in the same commit.",
    "- Tasks live in `.agents/tasks/` — one self-sufficient file per task, deleted on",
    "  delivery.",
    "",
    "## Rules index",
    "",
    renderBlock("rules-index", renderRulesIndexContent(), "html"),
    "",
  ].join("\n");
}
