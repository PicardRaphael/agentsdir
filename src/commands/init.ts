import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import * as prompts from "@clack/prompts";
import { defineCommand } from "citty";
import {
  detectGitSymlinks,
  detectStack,
  detectSymlinkSupport,
} from "../core/detect.js";
import { CliError } from "../core/errors.js";
import { upsertBlock } from "../core/managed-blocks.js";
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  renderManifest,
  type Manifest,
  type ProjectionMode,
} from "../core/manifest.js";
import { project } from "../core/projections.js";
import { resolveRepoRoot } from "../core/repo.js";
import { EXIT_CODES, type ExitCode } from "../exit-codes.js";
import {
  getPackContent,
  packInstallFiles,
  packSkillHash,
  renderLockSeed,
} from "../packs/index.js";
import {
  deriveRuleHook,
  renderAgentsMd,
  renderRulesIndexContent,
  type RuleIndexEntry,
} from "../templates/agents-md.js";
import {
  renderAgentsCheckWorkflow,
  renderGitattributes,
  renderGitignoreContent,
  renderMemoryTemplate,
  renderTasksReadme,
} from "../templates/bootstrap.js";
import { renderMemoryRule, renderTasksRule } from "../templates/rules.js";
import { CLI_VERSION } from "../version.js";

export const HARNESSES = ["claude", "codex", "cursor"] as const;
export const PACKS = [
  "core",
  "creator",
  "verification",
  "changelog",
  "worktrees",
] as const;

export interface InitAnswers {
  productName: string;
  description: string;
  commands: { dev?: string; test?: string; lint?: string };
  harnesses: string[];
  packs: string[];
  mode: ProjectionMode;
  stacks: string[];
}

export interface InitFlags {
  yes: boolean;
  harness?: string;
  packs?: string;
  mode?: string;
}

export type PlannedAction =
  "create" | "mkdir" | "update-block" | "skip-exists" | "link" | "project";

export interface PlannedWrite {
  /** Repo-relative path, always with forward slashes. */
  path: string;
  action: PlannedAction;
  content?: string;
}

export interface InitResult {
  exitCode: ExitCode;
  alreadyInitialized: boolean;
  changes: PlannedWrite[];
}

/**
 * Installs the architecture into `root`. Strictly additive: full files are
 * written only where nothing exists, shared files only get managed blocks.
 */
export async function runInit(
  root: string,
  answers: InitAnswers,
  options: { dryRun: boolean },
): Promise<InitResult> {
  if (await pathExists(join(root, MANIFEST_FILE))) {
    return { exitCode: EXIT_CODES.ok, alreadyInitialized: true, changes: [] };
  }
  if (answers.harnesses.includes("claude")) {
    // preflight: a foreign projection target aborts before any write
    await project(root, { mode: answers.mode, dryRun: true });
  }
  const changes = await buildPlan(root, answers);
  if (!options.dryRun) {
    await applyPlan(root, changes);
  }
  let hashes: Record<string, string> = {};
  if (answers.harnesses.includes("claude")) {
    const projection = await project(root, {
      mode: answers.mode,
      dryRun: options.dryRun,
    });
    if (answers.mode === "copy") {
      hashes = projection.hashes;
    }
    for (const change of projection.changes) {
      changes.push({
        path: change.path,
        action:
          change.action === "link"
            ? "link"
            : change.action === "write"
              ? "project"
              : "skip-exists",
      });
    }
  }
  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA,
    cliVersion: CLI_VERSION,
    project: { name: answers.productName, stack: answers.stacks },
    harness: { enabled: answers.harnesses },
    packs: { installed: answers.packs },
    ...(answers.packs.includes("worktrees")
      ? { worktrees: { setup: [], cleanup: [] } }
      : {}),
    projections: { mode: answers.mode, hashes },
  };
  const manifestWrite: PlannedWrite = {
    path: MANIFEST_FILE,
    action: "create",
    content: renderManifest(manifest),
  };
  changes.push(manifestWrite);
  if (!options.dryRun) {
    await applyPlan(root, [manifestWrite]);
  }
  return { exitCode: EXIT_CODES.ok, alreadyInitialized: false, changes };
}

/** Collects the interview answers, or the defaults with `--yes` / no TTY. */
export async function collectAnswers(
  root: string,
  flags: InitFlags,
): Promise<InitAnswers> {
  const stacks = await detectStack(root);
  const stackIds = stacks.map((stack) => stack.id);
  const defaults: InitAnswers = {
    productName: basename(root),
    description: "",
    commands: { ...(stacks[0]?.suggestions ?? {}) },
    harnesses:
      flags.harness === undefined
        ? [...HARNESSES]
        : parseList(flags.harness, HARNESSES, "--harness"),
    packs:
      flags.packs === undefined
        ? ["core", "creator"]
        : withCore(parseList(flags.packs, PACKS, "--packs")),
    mode:
      flags.mode === undefined ? await detectMode(root) : parseMode(flags.mode),
    stacks: stackIds,
  };
  const interactive =
    !flags.yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) {
    if (!flags.yes) {
      console.error("stdin is not a TTY — using defaults (same as --yes).");
    }
    return defaults;
  }
  prompts.intro("agentsdir init");
  const productName = ensureAnswer(
    await prompts.text({
      message: "Product name?",
      initialValue: defaults.productName,
    }),
  );
  const description = ensureAnswer(
    await prompts.text({
      message: "One-sentence description?",
      defaultValue: "",
      placeholder: "What this product does",
    }),
  );
  const dev = await askCommand(
    "Dev command? (leave empty to skip)",
    defaults.commands.dev,
  );
  const test = await askCommand(
    "Test command? (leave empty to skip)",
    defaults.commands.test,
  );
  const lint = await askCommand(
    "Lint command? (leave empty to skip)",
    defaults.commands.lint,
  );
  let harnesses = defaults.harnesses;
  if (flags.harness === undefined) {
    harnesses = ensureAnswer(
      await prompts.multiselect({
        message: "Target harnesses?",
        options: HARNESSES.map((name) => ({
          value: name as string,
          label: name,
        })),
        initialValues: [...HARNESSES] as string[],
        required: true,
      }),
    );
  }
  let packs = defaults.packs;
  if (flags.packs === undefined) {
    const optional = ensureAnswer(
      await prompts.multiselect({
        message: "Packs to install? (core is always installed)",
        options: PACKS.filter((name) => name !== "core").map((name) => ({
          value: name as string,
          label: name,
        })),
        initialValues: ["creator"],
        required: false,
      }),
    );
    packs = withCore(optional);
  }
  prompts.outro("Answers collected.");
  return {
    productName,
    description,
    commands: { dev, test, lint },
    harnesses,
    packs,
    mode: defaults.mode,
    stacks: stackIds,
  };
}

/** Human report for the collected result; the last lines advise the next commands. */
export function renderReport(
  result: InitResult,
  answers: InitAnswers,
  options: { dryRun: boolean },
): string {
  if (result.alreadyInitialized) {
    return "Already initialized — run `agentsdir sync` to regenerate.";
  }
  const lines: string[] = [];
  lines.push(
    options.dryRun
      ? "Dry run — nothing was written. Planned writes:"
      : "Installed:",
  );
  for (const change of result.changes) {
    lines.push(`  ${actionLabel(change.action)}  ${change.path}`);
  }
  lines.push("");
  lines.push(`Projection mode: ${answers.mode}`);
  lines.push(`Harnesses: ${answers.harnesses.join(", ")}`);
  lines.push(`Packs: ${answers.packs.join(", ")}`);
  lines.push("");
  lines.push("Next steps:");
  lines.push("  npx agentsdir add skill <name>   — create your first skill");
  lines.push(
    "  npx agentsdir check              — verify the installation (CI runs this)",
  );
  return lines.join("\n");
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Install the .agents/ architecture into the current git repo",
  },
  args: {
    yes: { type: "boolean", description: "Accept all defaults, ask nothing" },
    "dry-run": {
      type: "boolean",
      description: "Print the write plan without touching the disk",
    },
    harness: {
      type: "string",
      description: `Comma-separated harnesses (${HARNESSES.join(",")})`,
    },
    packs: {
      type: "string",
      description: `Comma-separated packs (${PACKS.join(",")})`,
    },
    mode: {
      type: "string",
      description:
        "Force the projection mode (symlink|copy) instead of detecting it",
    },
  },
  async run({ args }) {
    try {
      const root = await resolveRepoRoot(process.cwd());
      if (await pathExists(join(root, MANIFEST_FILE))) {
        console.log(
          "Already initialized — run `agentsdir sync` to regenerate.",
        );
        return;
      }
      const flags: InitFlags = {
        yes: args.yes === true,
        harness: typeof args.harness === "string" ? args.harness : undefined,
        packs: typeof args.packs === "string" ? args.packs : undefined,
        mode: typeof args.mode === "string" ? args.mode : undefined,
      };
      const dryRun = args["dry-run"] === true;
      const answers = await collectAnswers(root, flags);
      const result = await runInit(root, answers, { dryRun });
      console.log(renderReport(result, answers, { dryRun }));
      process.exitCode = result.exitCode;
    } catch (error) {
      if (error instanceof CliError) {
        console.error(error.message);
        process.exitCode = error.exitCode;
        return;
      }
      throw error;
    }
  },
});

const AGENT_DIRS = [
  ".agents/rules",
  ".agents/skills",
  ".agents/agents",
  ".agents/tasks",
  ".agents/plan",
  ".agents/memory.template",
  ".agents/memory",
];

async function buildPlan(
  root: string,
  answers: InitAnswers,
): Promise<PlannedWrite[]> {
  const plan: PlannedWrite[] = [];
  for (const dir of AGENT_DIRS) {
    if (!(await isDirectory(join(root, dir)))) {
      plan.push({ path: `${dir}/`, action: "mkdir" });
    }
  }
  // rule sources feeding the index: files already on disk plus planned ones
  const ruleSources = new Map<string, string>();
  for (const file of await listRuleFiles(root)) {
    ruleSources.set(
      file,
      await readFile(join(root, ".agents", "rules", file), "utf8"),
    );
  }
  const tasksRule = renderTasksRule(answers.commands);
  await planCreate(plan, root, ".agents/rules/tasks.md", tasksRule);
  if (!ruleSources.has("tasks.md")) {
    ruleSources.set("tasks.md", tasksRule);
  }
  const memoryRule = renderMemoryRule();
  await planCreate(plan, root, ".agents/rules/memory.md", memoryRule);
  if (!ruleSources.has("memory.md")) {
    ruleSources.set("memory.md", memoryRule);
  }
  // content packs selected at init: files, rules into the index, lock entries
  const lockEntries: { skill: string; hash: string }[] = [];
  for (const packName of answers.packs) {
    const pack = getPackContent(packName);
    if (pack === undefined) {
      continue;
    }
    const files = packInstallFiles(pack);
    const skippedSkills = new Set<string>();
    for (const skill of pack.skills) {
      // an existing folder is kept whole — writing our artifacts next to a
      // foreign SKILL.md would manufacture drift
      if (await isDirectory(join(root, ".agents", "skills", skill))) {
        skippedSkills.add(skill);
        plan.push({
          path: `.agents/skills/${skill}/SKILL.md`,
          action: "skip-exists",
        });
      } else {
        lockEntries.push({ skill, hash: packSkillHash(files, skill) });
      }
    }
    for (const file of files) {
      const skillFolder = file.path.match(/^\.agents\/skills\/([^/]+)\//)?.[1];
      if (skillFolder !== undefined && skippedSkills.has(skillFolder)) {
        continue;
      }
      await planCreate(plan, root, file.path, file.content);
      if (file.path.startsWith(".agents/rules/")) {
        const ruleFile = file.path.slice(".agents/rules/".length);
        if (!ruleSources.has(ruleFile)) {
          ruleSources.set(ruleFile, file.content);
        }
      }
    }
  }
  if (lockEntries.length > 0) {
    await planCreate(
      plan,
      root,
      "skills-lock.json",
      renderLockSeed(lockEntries),
    );
  }
  const ruleEntries: RuleIndexEntry[] = [...ruleSources.keys()]
    .sort()
    .map((file) => ({
      file,
      hook: deriveRuleHook(ruleSources.get(file) ?? ""),
    }));
  await planCreate(plan, root, ".agents/tasks/README.md", renderTasksReadme());
  await planCreate(
    plan,
    root,
    ".agents/memory.template/MEMORY.md",
    renderMemoryTemplate(),
  );
  for (const dir of [".agents/skills", ".agents/agents", ".agents/plan"]) {
    if (await isEmptyOrMissingDir(join(root, dir))) {
      await planCreate(plan, root, `${dir}/.gitkeep`, "");
    }
  }
  await planUpsertOrCreate(plan, root, "AGENTS.md", {
    create: () => renderAgentsMd(answers, ruleEntries),
    blockId: "rules-index",
    blockContent: renderRulesIndexContent(ruleEntries),
    style: "html",
  });
  await planUpsertOrCreate(plan, root, ".gitignore", {
    create: () => upsertBlock("", "ignore", renderGitignoreContent(), "hash"),
    blockId: "ignore",
    blockContent: renderGitignoreContent(),
    style: "hash",
  });
  await planCreate(plan, root, ".gitattributes", renderGitattributes());
  if (!(await isDirectory(join(root, ".github/workflows")))) {
    plan.push({ path: ".github/workflows/", action: "mkdir" });
  }
  await planCreate(
    plan,
    root,
    ".github/workflows/agents-check.yml",
    renderAgentsCheckWorkflow(),
  );
  return plan;
}

async function applyPlan(root: string, changes: PlannedWrite[]): Promise<void> {
  for (const change of changes) {
    const target = join(
      root,
      ...change.path.split("/").filter((part) => part !== ""),
    );
    if (change.action === "mkdir") {
      await mkdir(target, { recursive: true });
    } else if (
      (change.action === "create" || change.action === "update-block") &&
      change.content !== undefined
    ) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, change.content, "utf8");
    }
  }
}

async function planCreate(
  plan: PlannedWrite[],
  root: string,
  path: string,
  content: string,
): Promise<void> {
  if (await pathExists(join(root, path))) {
    plan.push({ path, action: "skip-exists" });
  } else {
    plan.push({ path, action: "create", content });
  }
}

async function planUpsertOrCreate(
  plan: PlannedWrite[],
  root: string,
  path: string,
  spec: {
    create: () => string;
    blockId: string;
    blockContent: string;
    style: "html" | "hash";
  },
): Promise<void> {
  const target = join(root, path);
  if (!(await pathExists(target))) {
    plan.push({ path, action: "create", content: spec.create() });
    return;
  }
  const current = await readFile(target, "utf8");
  const next = upsertBlock(
    current,
    spec.blockId,
    spec.blockContent,
    spec.style,
  );
  if (next === current) {
    plan.push({ path, action: "skip-exists" });
  } else {
    plan.push({ path, action: "update-block", content: next });
  }
}

async function detectMode(root: string): Promise<ProjectionMode> {
  const support = await detectSymlinkSupport(root);
  if (!support.supported) {
    return "copy";
  }
  const git = await detectGitSymlinks(root);
  return git.coreSymlinks === "false" ? "copy" : "symlink";
}

function parseList(
  raw: string,
  allowed: readonly string[],
  flag: string,
): string[] {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (values.length === 0) {
    throw new CliError(
      `${flag} needs at least one value (allowed: ${allowed.join(", ")}).`,
    );
  }
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new CliError(
        `Unknown value "${value}" for ${flag} (allowed: ${allowed.join(", ")}).`,
      );
    }
  }
  return [...new Set(values)];
}

function withCore(packs: string[]): string[] {
  return packs.includes("core") ? packs : ["core", ...packs];
}

function parseMode(raw: string): ProjectionMode {
  if (raw === "symlink" || raw === "copy") {
    return raw;
  }
  throw new CliError('Unknown value for --mode (allowed: "symlink", "copy").');
}

async function askCommand(
  message: string,
  initial: string | undefined,
): Promise<string | undefined> {
  const value = ensureAnswer(
    await prompts.text({
      message,
      initialValue: initial ?? "",
      defaultValue: "",
    }),
  );
  return value === "" ? undefined : value;
}

function ensureAnswer<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) {
    prompts.cancel("Init cancelled.");
    throw new CliError("Init cancelled.");
  }
  return value as T;
}

function actionLabel(action: PlannedAction): string {
  switch (action) {
    case "create":
      return "create      ";
    case "mkdir":
      return "create dir  ";
    case "update-block":
      return "update block";
    case "skip-exists":
      return "keep        ";
    case "link":
      return "link        ";
    case "project":
      return "project     ";
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isEmptyOrMissingDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return true;
  }
}

async function listRuleFiles(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, ".agents", "rules")))
      .filter((file) => file.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}
