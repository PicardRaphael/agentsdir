import { displayNameFromKebab, quote } from "./skill.js";

export interface AgentAnswers {
  /** Kebab-case, identical to the file name — Claude Code ignores files whose `name` drifts. */
  name: string;
  /** When to delegate to this agent. */
  description: string;
  color: string;
  model: string;
}

/** Valid non-TTY defaults; `--model` overrides the model. */
export function defaultAgentAnswers(name: string, model: string): AgentAnswers {
  return {
    name,
    description:
      "Delegate to this agent when the task matches the mission stated in its system prompt.",
    color: "blue",
    model,
  };
}

/**
 * Sub-agent template of `add agent`: the frontmatter Claude Code requires
 * (`name`, `description`) plus `color` and `model`, then a guided system prompt.
 */
export function renderAgentTemplate(answers: AgentAnswers): string {
  return [
    "---",
    `name: ${answers.name}`,
    `description: ${quote(answers.description)}`,
    `color: ${answers.color}`,
    `model: ${answers.model}`,
    "---",
    "",
    `You are ${displayNameFromKebab(answers.name)}, a focused sub-agent.`,
    "",
    "## Mission",
    "",
    "State the single job this agent does and the exact artifact it returns.",
    "Replace every placeholder line of this template before committing.",
    "",
    "## Method",
    "",
    "1. Read only what the mission needs; do not expand the scope.",
    "2. Work step by step and verify each intermediate result.",
    "3. Report the outcome first, then the evidence.",
    "",
    "## Boundaries",
    "",
    "- NEVER touch files outside the mission.",
    "- Ask instead of guessing when a decision is not yours to make.",
    "",
  ].join("\n");
}
