import {
  entryExists,
  isDirectory,
  pathExists,
  readdirEntriesOrEmpty,
  writeFileAtomic,
} from "../core/fs-utils.js";
import { HARNESSES, hasFileProjections } from "../core/harnesses.js";
import {
  collectAnswers,
  type InitAnswers,
  type InitFlags,
} from "./init-interview.js";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineCommand } from "citty";
import { asUserFacingError, CliError } from "../core/errors.js";
import { upsertBlock } from "../core/managed-blocks.js";
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  applyManifestPlan,
  planManifest,
  type Manifest,
} from "../core/manifest.js";
import { ensureNoLinkedParent, project } from "../core/projections.js";
import {
  applyPermissions,
  CLAUDE_SETTINGS_FILE,
  readSettings,
} from "../core/claude-permissions.js";
import { resolveRepoRoot } from "../core/repo.js";
import { EXIT_CODES, type ExitCode } from "../exit-codes.js";
import {
  getPackContent,
  packFileLockEntries,
  packInstallFiles,
  packScriptPaths,
  packSkillHash,
  PACKS,
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
  renderGitattributesContent,
  renderGitignoreContent,
  renderMemoryTemplate,
  renderTasksReadme,
} from "../templates/bootstrap.js";
import { renderMemoryRule, renderTasksRule } from "../templates/rules.js";
import { CLI_VERSION } from "../version.js";
import { listRuleFiles } from "../core/rules-index.js";
import { LOCK_FILE, planLock } from "../core/lock.js";

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
  if (hasFileProjections(answers.harnesses)) {
    // preflight: a foreign projection target aborts before any write
    await project(root, { mode: answers.mode, dryRun: true });
  }
  const changes = await buildPlan(root, answers);
  if (!options.dryRun) {
    await applyPlan(root, changes);
  }
  let hashes: Record<string, string> = {};
  if (hasFileProjections(answers.harnesses)) {
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
  const manifestPlan = await planManifest(root, manifest);
  changes.push({
    path: MANIFEST_FILE,
    action: "create",
    content: manifestPlan.content,
  });
  if (!options.dryRun) {
    // through the one gate, exclusively: `init` creates the manifest, and the
    // target must not already exist — a symlink there would take the write
    // outside the repository
    await applyManifestPlan(root, manifestPlan, { exclusive: true });
  }
  return { exitCode: EXIT_CODES.ok, alreadyInitialized: false, changes };
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
  if (answers.packs.includes("creator")) {
    // the structure is installed and empty: the first useful move is the
    // proposal that fills it, not a generator the user has to aim by hand
    lines.push(
      "  $propose-setup                   — ask your agent what this repo should configure",
    );
  }
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
    name: {
      type: "string",
      description: "Product name (default: the directory name)",
    },
    description: {
      type: "string",
      description: "One-sentence description of what this product does",
    },
    dev: { type: "string", description: "Dev command of this repo" },
    test: { type: "string", description: "Test command of this repo" },
    lint: { type: "string", description: "Lint command of this repo" },
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
    json: {
      type: "boolean",
      description: "Machine output: a single JSON object on stdout",
    },
  },
  async run({ args }) {
    const json = args.json === true;
    try {
      const root = await resolveRepoRoot(process.cwd());
      if (await pathExists(join(root, MANIFEST_FILE))) {
        const already: InitResult = {
          exitCode: EXIT_CODES.ok,
          alreadyInitialized: true,
          changes: [],
        };
        // no answers were collected, so there is no mode to report — the same
        // null the other commands write when they have none
        emitInit(json, already, null, {
          human: "Already initialized — run `agentsdir sync` to regenerate.",
        });
        return;
      }
      const text = (value: unknown): string | undefined =>
        typeof value === "string" && value !== "" ? value : undefined;
      const flags: InitFlags = {
        // --json asks for one object on stdout, and @clack writes its prompts
        // there: the interview would split the object a script came to parse.
        // Machine output means the defaults, exactly like --yes.
        yes: args.yes === true || json,
        ...(text(args.name) === undefined ? {} : { name: text(args.name) }),
        ...(text(args.description) === undefined
          ? {}
          : { description: text(args.description) }),
        ...(text(args.dev) === undefined ? {} : { dev: text(args.dev) }),
        ...(text(args.test) === undefined ? {} : { test: text(args.test) }),
        ...(text(args.lint) === undefined ? {} : { lint: text(args.lint) }),
        harness: typeof args.harness === "string" ? args.harness : undefined,
        packs: typeof args.packs === "string" ? args.packs : undefined,
        mode: typeof args.mode === "string" ? args.mode : undefined,
      };
      const dryRun = args["dry-run"] === true;
      const answers = await collectAnswers(root, flags);
      const result = await runInit(root, answers, { dryRun });
      emitInit(json, result, answers.mode, {
        human: renderReport(result, answers, { dryRun }),
      });
      process.exitCode = result.exitCode;
    } catch (rawError) {
      const error = asUserFacingError(rawError);
      if (error !== undefined) {
        if (json) {
          // stdout carries the object even on failure: a script parses stdout
          // whole, and a human sentence there crashes the parser reading it
          console.log(
            JSON.stringify({
              command: "init",
              mode: null,
              changes: [],
              errors: [
                {
                  path: "",
                  rule:
                    error.exitCode === EXIT_CODES.environmentOrUsage
                      ? "environment"
                      : "invariant",
                  message: error.message,
                  severity: "error",
                },
              ],
              exitCode: error.exitCode,
            }),
          );
        } else {
          console.error(error.message);
        }
        process.exitCode = error.exitCode;
        return;
      }
      throw rawError;
    }
  },
});

/**
 * `changes[]` of the machine report. `init` plans in its own vocabulary —
 * directories, links, projections, managed blocks — and reports in the one the
 * other nine commands share, so a script reads the ten the same way. The
 * planned `content` is deliberately dropped: it holds every emitted file, and
 * putting it on stdout would dump the whole installation into the pipe.
 */
export function initJsonChanges(
  result: InitResult,
): { path: string; action: "created" | "updated" | "ok" }[] {
  return result.changes.map((change) => ({
    path: change.path,
    action:
      change.action === "update-block"
        ? "updated"
        : change.action === "skip-exists"
          ? "ok"
          : "created",
  }));
}

/** One object on stdout with `--json`, the human report without it. */
function emitInit(
  json: boolean,
  result: InitResult,
  mode: string | null,
  human: { human: string },
): void {
  console.log(
    json
      ? JSON.stringify({
          command: "init",
          mode,
          changes: initJsonChanges(result),
          errors: [],
          exitCode: result.exitCode,
        })
      : human.human,
  );
}

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
  const lockFileEntries: { path: string; hash: string }[] = [];
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
      // only what this init really writes gets a lock entry: a rule already in
      // the repository is kept as it is, and locking it against our render
      // would report it modified before the user has touched anything
      if (plan[plan.length - 1]?.action === "create") {
        lockFileEntries.push(...packFileLockEntries([file]));
      }
      if (file.path.startsWith(".agents/rules/")) {
        const ruleFile = file.path.slice(".agents/rules/".length);
        if (!ruleSources.has(ruleFile)) {
          ruleSources.set(ruleFile, file.content);
        }
      }
    }
  }
  // through the shared planner, so the bytes `init` seeds and the bytes
  // `pack add` would produce for the same state are the same bytes
  const lockPlan = await planLock(root, {
    add: lockEntries,
    addFiles: lockFileEntries,
  });
  if (lockPlan?.content !== undefined) {
    await planCreate(plan, root, LOCK_FILE, lockPlan.content);
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
  // not planCreate: keeping an existing .gitattributes untouched is what left a
  // repo declaring `* text=auto` without `eol=lf` in permanent drift
  await planUpsertOrCreate(plan, root, ".gitattributes", {
    create: () =>
      upsertBlock(
        renderGitattributes(),
        "line-endings",
        renderGitattributesContent(),
        "hash",
      ),
    blockId: "line-endings",
    blockContent: renderGitattributesContent(),
    style: "hash",
  });
  if (hasFileProjections(answers.harnesses)) {
    // the allowlist covering the scripts the selected packs tell an agent to
    // run — without it, every run of one asks for permission
    const scripts = packScriptPaths(answers.packs);
    const current = await readSettings(root, CLAUDE_SETTINGS_FILE);
    const next = applyPermissions(current, scripts);
    if (next !== undefined) {
      // never through a link: a `.claude` symlink would carry this write into
      // the user's global Claude Code settings
      await ensureNoLinkedParent(root, CLAUDE_SETTINGS_FILE);
      plan.push({
        path: CLAUDE_SETTINGS_FILE,
        action: current === undefined ? "create" : "update-block",
        content: next,
      });
    }
  }
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
      // exclusive on a create: the target must not exist, symlink included, so
      // the CLI cannot write through a link and escape the repo it resolved
      await writeFileAtomic(target, change.content, {
        exclusive: change.action === "create",
      });
    }
  }
}

/**
 * A symlink — even a broken one — is an existing entry, so `entryExists`
 * (lstat) decides here rather than `pathExists` (stat, which follows the link).
 * With stat, a dangling `AGENTS.md -> /elsewhere/file` reads as absent, and the
 * write below lands outside the repository the CLI resolved.
 */
async function planCreate(
  plan: PlannedWrite[],
  root: string,
  path: string,
  content: string,
): Promise<void> {
  if (await entryExists(join(root, path))) {
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
  // entryExists, not pathExists: a dangling symlink is an entry, and planning a
  // "create" over it would write through the link, outside the repository
  if (!(await entryExists(target))) {
    plan.push({ path, action: "create", content: spec.create() });
    return;
  }
  if (!(await pathExists(target))) {
    throw new CliError(
      `${path} is a symlink to a target that does not exist. Remove it or point it at a real file, then run \`agentsdir init\` again — refusing to write through it.`,
      EXIT_CODES.driftOrInvariant,
    );
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

async function isEmptyOrMissingDir(path: string): Promise<boolean> {
  // absent counts as empty — that is the whole point of the question — but a
  // directory that exists and cannot be listed is not empty, it is unknown,
  // and `init` decides what to create from this answer
  return (
    (
      await readdirEntriesOrEmpty(
        path,
        "refusing to treat a directory it cannot list as an empty one",
      )
    ).length === 0
  );
}

// the interview is the other half of this command; callers import both here
export { collectAnswers, type InitAnswers, type InitFlags };
