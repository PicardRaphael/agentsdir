import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as prompts from "@clack/prompts";
import { defineCommand } from "citty";
import { CliError } from "../core/errors.js";
import { readManifest } from "../core/manifest.js";
import { resolveRepoRoot } from "../core/repo.js";
import { EXIT_CODES } from "../exit-codes.js";
import {
  defaultAgentAnswers,
  renderAgentTemplate,
  type AgentAnswers,
} from "../templates/agent.js";
import {
  ensureAnswer,
  ensureValidName,
  isInteractive,
  renderGeneratorReport,
  runGeneratorCli,
  type GeneratorResult,
} from "./add-common.js";

export const DEFAULT_AGENT_MODEL = "inherit";

/** Creates `.agents/agents/<name>.md` from the template; a taken name writes nothing. */
export async function runAddAgent(
  root: string,
  answers: AgentAnswers,
  options: { dryRun: boolean },
): Promise<GeneratorResult> {
  ensureValidName("agent", answers.name);
  const manifest = await readManifest(root);
  const agentFile = `${answers.name}.md`;
  const agentPath = `.agents/agents/${agentFile}`;
  if (await pathExists(join(root, ".agents", "agents", agentFile))) {
    throw new CliError(
      `Agent "${answers.name}" already exists (${agentPath}). Pick another name, or edit the existing file.`,
    );
  }
  if (!options.dryRun) {
    await mkdir(join(root, ".agents", "agents"), { recursive: true });
    await writeFile(
      join(root, ".agents", "agents", agentFile),
      renderAgentTemplate(answers),
      "utf8",
    );
  }
  return {
    changes: [{ path: agentPath, action: "created" }],
    exitCode: EXIT_CODES.ok,
    mode: manifest.projections.mode,
  };
}

/** Asks when to delegate to the agent; scripts and CI get the defaults. */
export async function collectAgentAnswers(
  name: string,
  model: string,
): Promise<AgentAnswers> {
  const defaults = defaultAgentAnswers(name, model);
  if (!isInteractive()) {
    console.error("stdin is not a TTY — using template defaults.");
    return defaults;
  }
  prompts.intro(`agentsdir add agent ${name}`);
  const description = ensureAnswer(
    await prompts.text({
      message: "When should work be delegated to this agent? (one sentence)",
      initialValue: defaults.description,
      validate: (value) =>
        (value ?? "").trim() === "" ? "A description is required." : undefined,
    }),
    "add agent",
  );
  prompts.outro("Answers collected.");
  return { ...defaults, description };
}

export const addAgentCommand = defineCommand({
  meta: {
    name: "agent",
    description: "Create a sub-agent in .agents/agents/",
  },
  args: {
    name: {
      type: "positional",
      description: "Agent name (kebab-case)",
      required: true,
    },
    model: {
      type: "string",
      description: `Model for the agent frontmatter (default: ${DEFAULT_AGENT_MODEL})`,
    },
    "dry-run": {
      type: "boolean",
      description: "Print the write plan without touching the disk",
    },
    json: {
      type: "boolean",
      description: "Machine output: a single JSON object on stdout",
    },
  },
  async run({ args }) {
    const dryRun = args["dry-run"] === true;
    await runGeneratorCli("add agent", args.json === true, async () => {
      const root = await resolveRepoRoot(process.cwd());
      const name = String(args.name);
      ensureValidName("agent", name);
      const model =
        typeof args.model === "string" && args.model.trim() !== ""
          ? args.model.trim()
          : DEFAULT_AGENT_MODEL;
      if (model.includes("\n")) {
        throw new CliError("--model must be a single-line value.");
      }
      const answers = await collectAgentAnswers(name, model);
      const result = await runAddAgent(root, answers, { dryRun });
      return { result, report: renderGeneratorReport(result, { dryRun }) };
    });
  },
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
