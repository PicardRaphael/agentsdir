import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineCommand } from "citty";
import { renderOpenAiYaml, renderSkillIcon } from "../core/codex-metadata.js";
import { CliError } from "../core/errors.js";
import { parseSkillMarkdown } from "../core/frontmatter.js";
import { upsertBlock } from "../core/managed-blocks.js";
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  readManifest,
  renderManifest,
  type Manifest,
  type ProjectionMode,
} from "../core/manifest.js";
import { project } from "../core/projections.js";
import { resolveRepoRoot } from "../core/repo.js";
import {
  computeSkillHash,
  validateRepo,
  type Violation,
} from "../core/validate.js";
import { EXIT_CODES, type ExitCode } from "../exit-codes.js";
import {
  deriveRuleHook,
  renderRulesIndexContent,
  type RuleIndexEntry,
} from "../templates/agents-md.js";
import { CLI_VERSION } from "../version.js";

export type SyncAction = "created" | "updated" | "ok";

export interface SyncChange {
  /** Repo-relative path, always with forward slashes. */
  path: string;
  action: SyncAction;
}

export interface SyncResult {
  changes: SyncChange[];
  /** Source invariants that blocked the run; empty when sync proceeded. */
  violations: Violation[];
  exitCode: ExitCode;
  mode: ProjectionMode;
}

/**
 * Drift kinds sync repairs by regenerating. Any other error-severity violation
 * is a source problem: sync then fails with the validate diagnostic instead of
 * "fixing" the source silently.
 */
const REPAIRABLE_RULES = new Set([
  "projection-missing",
  "projection-modified",
  "projection-replaced-by-copy",
  "projection-header-removed",
  "codex-artifact-missing",
  "codex-artifact-drift",
  "rules-index-missing",
  "rules-index-out-of-sync",
  "lock-drift",
]);

interface PlannedFile {
  path: string;
  action: SyncAction;
  /** Bytes to write; absent when the file is already up to date. */
  content?: Buffer;
}

/**
 * Regenerates every projection from the source of truth. The whole plan is
 * computed before anything touches the disk, so a blocked run writes nothing
 * and `--dry-run` reports exactly what a real run would do.
 */
export async function runSync(
  root: string,
  options: { dryRun: boolean },
): Promise<SyncResult> {
  const manifest = await readManifest(root);
  const mode = manifest.projections.mode;
  const violations = await validateRepo(root, manifest);
  const blocking = violations.filter(
    (violation) =>
      violation.severity === "error" && !REPAIRABLE_RULES.has(violation.rule),
  );
  if (blocking.length > 0) {
    return {
      changes: [],
      violations: blocking,
      exitCode: EXIT_CODES.driftOrInvariant,
      mode,
    };
  }
  const planned: PlannedFile[] = [];
  const overlay: Record<string, Buffer> = {};
  for (const artifact of await planCodexArtifacts(root)) {
    overlay[artifact.path] = artifact.content ?? Buffer.alloc(0);
    planned.push(artifact);
  }
  let projectionHashes: Record<string, string> = {};
  const claudeEnabled = manifest.harness.enabled.includes("claude");
  if (claudeEnabled) {
    const plan = await project(root, {
      mode,
      dryRun: true,
      previousHashes: manifest.projections.hashes,
      overlay,
    });
    projectionHashes = plan.hashes;
    for (const change of plan.changes) {
      planned.push({
        path: change.path,
        action:
          change.action === "unchanged"
            ? "ok"
            : change.existed
              ? "updated"
              : "created",
      });
    }
  }
  planned.push(await planRulesIndex(root));
  const lock = await planLock(root, overlay);
  if (lock !== undefined) {
    planned.push(lock);
  }
  const manifestPlan = await planManifest(root, manifest, projectionHashes);
  planned.push(manifestPlan);
  if (!options.dryRun) {
    for (const file of planned) {
      if (file.path !== MANIFEST_FILE) {
        await applyPlannedFile(root, file);
      }
    }
    if (claudeEnabled) {
      await project(root, {
        mode,
        dryRun: false,
        previousHashes: manifest.projections.hashes,
        overlay,
      });
    }
    // the manifest is written last: its fingerprints describe the final state
    await applyPlannedFile(root, manifestPlan);
  }
  const changes = planned
    .map(({ path, action }) => ({ path, action }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { changes, violations: [], exitCode: EXIT_CODES.ok, mode };
}

export function renderSyncReport(
  result: SyncResult,
  options: { dryRun: boolean },
): string {
  if (result.violations.length > 0) {
    const lines = result.violations.map(
      (violation) =>
        `drift  ${violation.path} · ${violation.rule} · ${violation.message}`,
    );
    lines.push(
      "Sync aborted — fix the source invariants above; nothing was written.",
    );
    return lines.join("\n");
  }
  const lines: string[] = [];
  lines.push(
    options.dryRun
      ? "Dry run — nothing was written. Full write plan:"
      : "Synced:",
  );
  for (const change of result.changes) {
    lines.push(`  ${actionLabel(change.action)}  ${change.path}`);
  }
  const count = (action: SyncAction): number =>
    result.changes.filter((change) => change.action === action).length;
  lines.push("");
  lines.push(
    options.dryRun
      ? `Plan: ${count("created")} to create, ${count("updated")} to update, ${count("ok")} already up to date.`
      : `Done: ${count("created")} created, ${count("updated")} updated, ${count("ok")} already up to date.`,
  );
  return lines.join("\n");
}

function actionLabel(action: SyncAction): string {
  switch (action) {
    case "created":
      return "created";
    case "updated":
      return "updated";
    case "ok":
      return "ok     ";
  }
}

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description:
      "Regenerate every projection from the source of truth (.agents/, AGENTS.md)",
  },
  args: {
    "dry-run": {
      type: "boolean",
      description: "Print the full write plan without touching the disk",
    },
    json: {
      type: "boolean",
      description: "Machine output: a single JSON object on stdout",
    },
  },
  async run({ args }) {
    const json = args.json === true;
    const dryRun = args["dry-run"] === true;
    try {
      const root = await resolveRepoRoot(process.cwd());
      const result = await runSync(root, { dryRun });
      if (json) {
        console.log(
          JSON.stringify({
            command: "sync",
            mode: result.mode,
            changes: result.changes,
            errors: result.violations,
            exitCode: result.exitCode,
          }),
        );
      } else {
        console.log(renderSyncReport(result, { dryRun }));
      }
      process.exitCode = result.exitCode;
    } catch (error) {
      if (error instanceof CliError) {
        if (json) {
          console.log(
            JSON.stringify({
              command: "sync",
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
      throw error;
    }
  },
});

/** Codex artifacts of every skill, derived from the frontmatter (the catalogue). */
async function planCodexArtifacts(root: string): Promise<PlannedFile[]> {
  const skillsDir = join(root, ".agents", "skills");
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const planned: PlannedFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    // the source parses and its icon exists: validateRepo blocked otherwise
    const source = await readFile(
      join(skillsDir, entry.name, "SKILL.md"),
      "utf8",
    );
    const { frontmatter } = parseSkillMarkdown(source);
    const artifacts: [string, string][] = [
      ["agents/openai.yaml", renderOpenAiYaml(frontmatter)],
      ["assets/icon.svg", renderSkillIcon(frontmatter)],
    ];
    for (const [rel, rendered] of artifacts) {
      const path = `.agents/skills/${entry.name}/${rel}`;
      const content = Buffer.from(rendered, "utf8");
      planned.push({
        path,
        content,
        action: await compareToDisk(root, path, content),
      });
    }
  }
  return planned;
}

/** Rules index managed block of AGENTS.md, regenerated from `.agents/rules/`. */
async function planRulesIndex(root: string): Promise<PlannedFile> {
  let current: string;
  try {
    current = await readFile(join(root, "AGENTS.md"), "utf8");
  } catch {
    throw new CliError(
      "AGENTS.md is missing — run `agentsdir init`.",
      EXIT_CODES.driftOrInvariant,
    );
  }
  const entries: RuleIndexEntry[] = [];
  for (const file of await listRuleFiles(root)) {
    entries.push({
      file,
      hook: deriveRuleHook(
        await readFile(join(root, ".agents", "rules", file), "utf8"),
      ),
    });
  }
  const next = upsertBlock(
    current,
    "rules-index",
    renderRulesIndexContent(entries),
    "html",
  );
  if (next === current) {
    return { path: "AGENTS.md", action: "ok" };
  }
  return {
    path: "AGENTS.md",
    action: "updated",
    content: Buffer.from(next, "utf8"),
  };
}

/**
 * skills-lock.json fingerprints: entries vendored from GitHub are re-locked to
 * the current folder state (the conscious local update `check` asks for);
 * `agentsdir` entries stay pinned to the installed version (protection of
 * `update`), never recomputed.
 */
async function planLock(
  root: string,
  overlay: Record<string, Buffer>,
): Promise<PlannedFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(root, "skills-lock.json"), "utf8");
  } catch {
    return undefined;
  }
  // shape guaranteed by validateRepo (lock-invalid blocks the run)
  const data: unknown = JSON.parse(raw);
  const skills = (data as { skills?: unknown }).skills as Record<
    string,
    unknown
  >;
  for (const [name, entryRaw] of Object.entries(skills)) {
    const entry = entryRaw as Record<string, unknown>;
    if (entry["sourceType"] === "agentsdir") {
      continue;
    }
    const prefix = `.agents/skills/${name}/`;
    const skillOverlay: Record<string, Buffer> = {};
    for (const [key, content] of Object.entries(overlay)) {
      if (key.startsWith(prefix)) {
        skillOverlay[key.slice(prefix.length)] = content;
      }
    }
    entry["computedHash"] = await computeSkillHash(
      join(root, ".agents", "skills", name),
      skillOverlay,
    );
  }
  const rendered = `${JSON.stringify(data, null, 2)}\n`;
  if (rendered === raw) {
    return { path: "skills-lock.json", action: "ok" };
  }
  return {
    path: "skills-lock.json",
    action: "updated",
    content: Buffer.from(rendered, "utf8"),
  };
}

/** Manifest fingerprints: mode untouched, hashes replaced by this run's. */
async function planManifest(
  root: string,
  manifest: Manifest,
  hashes: Record<string, string>,
): Promise<PlannedFile> {
  const next: Manifest = {
    schema: MANIFEST_SCHEMA,
    cliVersion: CLI_VERSION,
    project: manifest.project,
    harness: manifest.harness,
    packs: manifest.packs,
    projections: { mode: manifest.projections.mode, hashes },
  };
  const rendered = renderManifest(next);
  const current = await readFile(join(root, MANIFEST_FILE), "utf8");
  if (rendered === current) {
    return { path: MANIFEST_FILE, action: "ok" };
  }
  return {
    path: MANIFEST_FILE,
    action: "updated",
    content: Buffer.from(rendered, "utf8"),
  };
}

async function applyPlannedFile(
  root: string,
  file: PlannedFile,
): Promise<void> {
  if (file.action === "ok" || file.content === undefined) {
    return;
  }
  const abs = join(root, ...file.path.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, file.content);
}

async function compareToDisk(
  root: string,
  path: string,
  expected: Buffer,
): Promise<SyncAction> {
  let current: Buffer;
  try {
    current = await readFile(join(root, ...path.split("/")));
  } catch {
    return "created";
  }
  return current.equals(expected) ? "ok" : "updated";
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
