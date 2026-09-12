import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as prompts from "@clack/prompts";
import { defineCommand } from "citty";
import { CliError } from "../core/errors.js";
import { resolveRepoRoot } from "../core/repo.js";
import { EXIT_CODES } from "../exit-codes.js";
import { renderRuleTemplate, type RuleAnswers } from "../templates/rules.js";
import {
  ensureAnswer,
  ensureValidName,
  ensureWritable,
  isInteractive,
  renderGeneratorReport,
  resyncProjections,
  runGeneratorCli,
  type GeneratorChange,
  type GeneratorResult,
  type GeneratorTarget,
} from "./add-common.js";
import { planRulesIndex } from "../core/rules-index.js";

export const DEFAULT_RULE_HOOK =
  "Read before touching the files this rule covers.";

/** What `add rule <name>` would create, and why it would refuse to. */
export function ruleTarget(name: string): GeneratorTarget {
  const path = `.agents/rules/${name}.md`;
  return {
    path,
    refusal: `Rule "${name}" already exists (${path}). Pick another name, or edit the existing file — \`sync\` keeps the index in step.`,
  };
}

/** Usage error (exit 2) when `--hook` carries what its prompt would have refused. */
export function ensureValidRuleHook(hook: string | undefined): void {
  if (hook !== undefined && hook.trim() === "") {
    throw new CliError("--hook: the sentence is required.");
  }
}

/**
 * Creates `.agents/rules/<name>.md` from the template and regenerates the
 * whole `rules-index` managed block of AGENTS.md (disk rules plus the new
 * one), exactly as `sync` derives it — so the entry is never duplicated and
 * the next `sync` reports AGENTS.md unchanged. The full plan is computed
 * before any write: a refused run writes nothing.
 */
export async function runAddRule(
  root: string,
  answers: RuleAnswers,
  options: { dryRun: boolean },
): Promise<GeneratorResult> {
  ensureValidName("rule", answers.name);
  const manifest = await ensureWritable(root, ruleTarget(answers.name));
  const ruleFile = `${answers.name}.md`;
  const rulePath = `.agents/rules/${ruleFile}`;
  const source = renderRuleTemplate(answers);
  const indexPlan = await planRulesIndex(root, {
    add: [{ file: ruleFile, content: source }],
  });
  const changes: GeneratorChange[] = [{ path: rulePath, action: "created" }];
  if (indexPlan !== undefined) {
    changes.push({ path: "AGENTS.md", action: "updated" });
  }
  if (!options.dryRun) {
    await mkdir(join(root, ".agents", "rules"), { recursive: true });
    await writeFile(join(root, ".agents", "rules", ruleFile), source, "utf8");
    if (indexPlan !== undefined) {
      await writeFile(join(root, "AGENTS.md"), indexPlan.next, "utf8");
    }
  }
  return {
    changes: [
      ...changes,
      ...(await resyncProjections(root, manifest, {
        ...options,
        overlay: { [rulePath]: source },
      })),
    ],
    exitCode: EXIT_CODES.ok,
    mode: manifest.projections.mode,
  };
}

/**
 * Asks the "when to read it" sentence, unless `--hook` already gave it. Without
 * a TTY and without the flag the generic default is used — which is why the
 * flag exists: it is the only way a script or an agent can put a real sentence
 * there (`docs/commandes.md`).
 */
export async function collectRuleAnswers(
  name: string,
  paths: string[],
  flags: { hook?: string } = {},
): Promise<RuleAnswers> {
  if (flags.hook !== undefined) {
    return { name, hook: flags.hook, paths };
  }
  if (!isInteractive()) {
    console.error("stdin is not a TTY — using template defaults for --hook.");
    return { name, hook: DEFAULT_RULE_HOOK, paths };
  }
  prompts.intro(`agentsdir add rule ${name}`);
  const hook = ensureAnswer(
    await prompts.text({
      message:
        'When should an agent read this rule? (one sentence, e.g. "Read before touching src/api/**.")',
      initialValue: DEFAULT_RULE_HOOK,
      validate: (value) =>
        (value ?? "").trim() === "" ? "The sentence is required." : undefined,
    }),
    "add rule",
  );
  prompts.outro("Answers collected.");
  return { name, hook, paths };
}

/** Parses `--paths "<glob>[,<glob>]"`; the flag given empty is a usage error. */
export function parsePathsFlag(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  const globs = raw
    .split(",")
    .map((glob) => glob.trim())
    .filter((glob) => glob !== "");
  if (globs.length === 0) {
    throw new CliError('--paths needs at least one glob (e.g. "src/api/**").');
  }
  return globs;
}

export const addRuleCommand = defineCommand({
  meta: {
    name: "rule",
    description:
      "Create a rule in .agents/rules/ and index it in AGENTS.md (managed block)",
  },
  args: {
    name: {
      type: "positional",
      description: "Rule name (kebab-case)",
      required: true,
    },
    paths: {
      type: "string",
      description:
        'Scope the rule to comma-separated globs (e.g. "src/api/**")',
    },
    hook: {
      type: "string",
      description:
        'When an agent should read this rule (one sentence, e.g. "Read before touching src/api/**.")',
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
    await runGeneratorCli("add rule", args.json === true, async () => {
      const root = await resolveRepoRoot(process.cwd());
      const name = String(args.name);
      ensureValidName("rule", name);
      const paths = parsePathsFlag(
        typeof args.paths === "string" ? args.paths : undefined,
      );
      const hook = typeof args.hook === "string" ? args.hook : undefined;
      ensureValidRuleHook(hook);
      // the refusal comes before the question: a taken name, or a repo without
      // a manifest, must not cost an answer first
      await ensureWritable(root, ruleTarget(name));
      const answers = await collectRuleAnswers(
        name,
        paths,
        hook === undefined ? {} : { hook },
      );
      const result = await runAddRule(root, answers, { dryRun });
      return { result, report: renderGeneratorReport(result, { dryRun }) };
    });
  },
});
