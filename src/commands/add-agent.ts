import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as prompts from "@clack/prompts";
import { defineCommand } from "citty";
import { CliError } from "../core/errors.js";
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
  ensureWritable,
  isInteractive,
  renderGeneratorReport,
  resyncProjections,
  runGeneratorCli,
  type GeneratorResult,
  type GeneratorTarget,
} from "./add-common.js";

export const DEFAULT_AGENT_MODEL = "inherit";

/** What `add agent <name>` would create, and why it would refuse to. */
export function agentTarget(name: string): GeneratorTarget {
  const path = `.agents/agents/${name}.md`;
  return {
    path,
    refusal: `Agent "${name}" already exists (${path}). Pick another name, or edit the existing file.`,
  };
}

/** Usage error (exit 2) when `--description` carries what its prompt would have refused. */
export function ensureValidAgentDescription(
  description: string | undefined,
): void {
  if (description !== undefined && description.trim() === "") {
    throw new CliError("--description: a description is required.");
  }
}

/** Creates `.agents/agents/<name>.md` from the template; a taken name writes nothing. */
export async function runAddAgent(
  root: string,
  answers: AgentAnswers,
  options: { dryRun: boolean },
): Promise<GeneratorResult> {
  ensureValidName("agent", answers.name);
  const manifest = await ensureWritable(root, agentTarget(answers.name));
  const agentFile = `${answers.name}.md`;
  const agentPath = `.agents/agents/${agentFile}`;
  const source = renderAgentTemplate(answers);
  if (!options.dryRun) {
    await mkdir(join(root, ".agents", "agents"), { recursive: true });
    await writeFile(join(root, ".agents", "agents", agentFile), source, "utf8");
  }
  return {
    changes: [
      { path: agentPath, action: "created" as const },
      ...(await resyncProjections(root, manifest, {
        ...options,
        overlay: { [agentPath]: source },
      })),
    ],
    exitCode: EXIT_CODES.ok,
    mode: manifest.projections.mode,
  };
}

/**
 * Asks when to delegate to the agent, unless `--description` already said so.
 * Without a TTY and without the flag the generic default is used — the flag is
 * what lets a script or an agent answer for real (`docs/commandes.md`).
 */
export async function collectAgentAnswers(
  name: string,
  model: string,
  flags: { description?: string } = {},
): Promise<AgentAnswers> {
  const defaults = defaultAgentAnswers(name, model);
  if (flags.description !== undefined) {
    return { ...defaults, description: flags.description };
  }
  if (!isInteractive()) {
    console.error(
      "stdin is not a TTY — using template defaults for --description.",
    );
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
    description: {
      type: "string",
      description: "When work should be delegated to this agent (one sentence)",
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
      const description =
        typeof args.description === "string" ? args.description : undefined;
      ensureValidAgentDescription(description);
      // the refusal comes before the question: a taken name, or a repo without
      // a manifest, must not cost an answer first
      await ensureWritable(root, agentTarget(name));
      const answers = await collectAgentAnswers(
        name,
        model,
        description === undefined ? {} : { description },
      );
      const result = await runAddAgent(root, answers, { dryRun });
      return { result, report: renderGeneratorReport(result, { dryRun }) };
    });
  },
});
