import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineCommand } from "citty";
import { renderOpenAiYaml, renderSkillIcon } from "../core/codex-metadata.js";
import { asUserFacingError } from "../core/errors.js";
import {
  parseOpenSkillMarkdown,
  parseSkillMarkdown,
} from "../core/frontmatter.js";
import {
  planHookRegistrations,
  type HookRegistryPlan,
} from "../core/hook-registries.js";
import {
  applyPermissions,
  CLAUDE_SETTINGS_FILE,
  readSettings,
} from "../core/claude-permissions.js";
import { packScriptPaths, renderLock } from "../packs/index.js";
import {
  MANIFEST_FILE,
  parseMode,
  readManifest,
  renderManifest,
  type Manifest,
  type ProjectionMode,
} from "../core/manifest.js";
import { entryExists, writeFileAtomic } from "../core/fs-utils.js";
import {
  ensureNoLinkedParent,
  refreshProjections,
  unproject,
} from "../core/projections.js";
import { planRulesIndex } from "../core/rules-index.js";
import { resolveRepoRoot } from "../core/repo.js";
import { computeSkillHash } from "../core/skill-hash.js";
import { NAME_SPEC, validateRepo, type Violation } from "../core/validate.js";
import { EXIT_CODES, type ExitCode } from "../exit-codes.js";
import { CLI_VERSION } from "../version.js";

export type SyncAction = "created" | "updated" | "removed" | "ok";

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
  "projection-stale",
  "projection-orphan",
  "codex-artifact-missing",
  "codex-artifact-drift",
  "rules-index-missing",
  "rules-index-out-of-sync",
  "lock-drift",
  // sync is what recomputes the registrations, so its own drift must not
  // block it — otherwise check tells you to run sync, and sync refuses
  "hook-registration-drift",
]);

/** A rule of the source of truth, as the overlay keys spell it. */
const RULE_SOURCE = /^\.agents\/rules\/[^/]+\.md$/;

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
  options: {
    dryRun: boolean;
    mode?: ProjectionMode;
    /**
     * Source-of-truth files a caller is about to write, keyed by repo-relative
     * POSIX path. `update` upgrades installed content and then syncs: without
     * this, its `--dry-run` would plan the projections of the *old* content and
     * report as "ok" every file the real run updates.
     */
    sourceOverlay?: Record<string, Buffer>;
  },
): Promise<SyncResult> {
  const manifest = await readManifest(root);
  const sourceOverlay = options.sourceOverlay ?? {};
  const previousMode = manifest.projections.mode;
  // an explicit --mode is the only way the mode ever changes (never recomputed);
  // refreshProjections turns the difference into the removal it implies
  const mode = options.mode ?? previousMode;
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
  // artifacts are derived from the overlaid sources and override them: both
  // sides of the projection then describe the same state
  const overlay: Record<string, Buffer> = { ...sourceOverlay };
  for (const artifact of await planCodexArtifacts(root, sourceOverlay)) {
    overlay[artifact.path] = artifact.content ?? Buffer.alloc(0);
    planned.push(artifact);
  }
  let projectionHashes: Record<string, string>;
  let removed: string[];
  const claudeEnabled = manifest.harness.enabled.includes("claude");
  if (claudeEnabled) {
    const plan = await refreshProjections(root, {
      mode,
      previousMode,
      previousHashes: manifest.projections.hashes,
      overlay,
      dryRun: true,
    });
    projectionHashes = plan.hashes;
    removed = plan.removed;
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
  } else {
    // claude left [harness] enabled: step 6 of `sync` in docs/commandes.md.
    // Without this branch the projections stayed frozen on disk — loaded by the
    // harness, updated by nothing — while sync reported "0 removed" and emptied
    // [projections.hashes], losing even the record of what it had written.
    const plan = await unproject(root, {
      mode: previousMode,
      dryRun: true,
      previousHashes: manifest.projections.hashes,
    });
    removed = plan.removed;
    projectionHashes = await survivingHashes(
      root,
      manifest.projections.hashes,
      new Set(removed),
    );
  }
  for (const path of removed) {
    planned.push({ path, action: "removed" });
  }
  planned.push(await planRulesIndexFile(root, sourceOverlay));
  // hook registrations: regenerated from the scripts in .agents/hooks/ —
  // a deleted script loses its registrations here (clean deregistration)
  const registries = await planHookRegistrations(
    root,
    manifest.harness.enabled,
  );
  for (const registry of registries) {
    if (registry.path === CLAUDE_SETTINGS_FILE) {
      continue;
    }
    planned.push({
      path: registry.path,
      action: registry.action,
      ...(registry.content !== undefined
        ? { content: Buffer.from(registry.content, "utf8") }
        : {}),
    });
  }
  // .claude/settings.json carries both the hook registrations and the
  // permission allowlist: two plans for one path would clobber each other, so
  // the permissions are merged onto what the registration plan produced
  const claudeSettings = await planClaudeSettings(root, registries, manifest);
  if (claudeSettings !== undefined) {
    planned.push(claudeSettings);
  }
  const lock = await planLock(root, overlay);
  if (lock !== undefined) {
    planned.push(lock);
  }
  const manifestPlan = await planManifest(
    root,
    manifest,
    mode,
    projectionHashes,
  );
  planned.push(manifestPlan);
  if (!options.dryRun) {
    for (const file of planned) {
      if (file.path !== MANIFEST_FILE) {
        await applyPlannedFile(root, file);
      }
    }
    if (claudeEnabled) {
      await refreshProjections(root, {
        mode,
        previousMode,
        previousHashes: manifest.projections.hashes,
        overlay,
      });
    } else {
      await unproject(root, {
        mode: previousMode,
        previousHashes: manifest.projections.hashes,
      });
    }
    // the manifest is written last: its fingerprints describe the final state
    await applyPlannedFile(root, manifestPlan);
  }
  // removals first: that is the order they happen in, and a switch would
  // otherwise interleave "created CLAUDE.md" with "removed CLAUDE.md"
  const changes = planned
    .map(({ path, action }) => ({ path, action }))
    .sort((a, b) => {
      const rank = (change: SyncChange): number =>
        change.action === "removed" ? 0 : 1;
      return (
        rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      );
    });
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
      ? `Plan: ${count("created")} to create, ${count("updated")} to update, ${count("removed")} to remove, ${count("ok")} already up to date.`
      : `Done: ${count("created")} created, ${count("updated")} updated, ${count("removed")} removed, ${count("ok")} already up to date.`,
  );
  return lines.join("\n");
}

function actionLabel(action: SyncAction): string {
  switch (action) {
    case "created":
      return "created";
    case "updated":
      return "updated";
    case "removed":
      return "removed";
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
    mode: {
      type: "string",
      description:
        "Switch the projection mode (symlink|copy): the manifest is updated and every projection regenerated",
    },
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
      const mode =
        typeof args.mode === "string" ? parseMode(args.mode) : undefined;
      const result = await runSync(root, {
        dryRun,
        ...(mode === undefined ? {} : { mode }),
      });
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
    } catch (rawError) {
      const error = asUserFacingError(rawError);
      if (error !== undefined) {
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
      throw rawError;
    }
  },
});

/**
 * The single plan for `.claude/settings.json`: the hook registrations this run
 * computed, with the permission allowlist merged onto them. A harness dropped
 * from `[harness] enabled` expects no rule, so the same pass removes ours —
 * the symmetric move to the deregistration the hook planner already does.
 */
async function planClaudeSettings(
  root: string,
  registries: HookRegistryPlan[],
  manifest: Manifest,
): Promise<PlannedFile | undefined> {
  const registry = registries.find(
    (plan) => plan.path === CLAUDE_SETTINGS_FILE,
  );
  const onDisk = await readSettings(root, CLAUDE_SETTINGS_FILE);
  // what the registration plan would write, or the file as it stands
  const base = registry?.content ?? onDisk;
  const scripts = manifest.harness.enabled.includes("claude")
    ? packScriptPaths(manifest.packs.installed)
    : [];
  const merged = applyPermissions(base, scripts) ?? base;
  // an absent file with nothing to put in it is not a change and not an "ok"
  // either: creating one, or naming it in the report, would be noise in a repo
  // that never asked for it
  if (merged === undefined) {
    return undefined;
  }
  if (merged === onDisk) {
    return { path: CLAUDE_SETTINGS_FILE, action: "ok" };
  }
  return {
    path: CLAUDE_SETTINGS_FILE,
    action: onDisk === undefined ? "created" : "updated",
    content: Buffer.from(merged, "utf8"),
  };
}

/** Codex artifacts of every skill, derived from the frontmatter (the catalogue). */
async function planCodexArtifacts(
  root: string,
  sourceOverlay: Record<string, Buffer>,
): Promise<PlannedFile[]> {
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
    const overlaid = sourceOverlay[`.agents/skills/${entry.name}/SKILL.md`];
    const source =
      overlaid === undefined
        ? await readFile(join(skillsDir, entry.name, "SKILL.md"), "utf8")
        : overlaid.toString("utf8");
    // no catalogue field means the skill belongs to another tool (npx skills,
    // hand-written to the open spec): sync leaves the folder untouched — a
    // catalogue skill with missing artifacts was already blocked by validateRepo
    if (!parseOpenSkillMarkdown(source).catalogue) {
      continue;
    }
    // the source parses and its icon exists: validateRepo blocked otherwise
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
async function planRulesIndexFile(
  root: string,
  sourceOverlay: Record<string, Buffer>,
): Promise<PlannedFile> {
  const add = Object.entries(sourceOverlay)
    .filter(([path]) => RULE_SOURCE.test(path))
    .map(([path, content]) => ({
      file: path.slice(".agents/rules/".length),
      content: content.toString("utf8"),
    }));
  const plan = await planRulesIndex(root, { add });
  if (plan === undefined) {
    return { path: "AGENTS.md", action: "ok" };
  }
  return {
    path: "AGENTS.md",
    action: "updated",
    content: Buffer.from(plan.next, "utf8"),
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
    // validateRepo already refused an invalid key; belt and braces, since this
    // one builds a path that reads and hashes a directory
    if (!NAME_SPEC.test(name)) {
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
  // through renderLock like every other writer: a lock whose tables were left
  // in insertion order by an older CLI is normalised here rather than kept as
  // a second rendering of one state
  const rendered = renderLock(data as Record<string, unknown>);
  if (rendered === raw) {
    return { path: "skills-lock.json", action: "ok" };
  }
  return {
    path: "skills-lock.json",
    action: "updated",
    content: Buffer.from(rendered, "utf8"),
  };
}

/** Manifest fingerprints: hashes replaced by this run's, mode only on a switch. */
async function planManifest(
  root: string,
  manifest: Manifest,
  mode: ProjectionMode,
  hashes: Record<string, string>,
): Promise<PlannedFile> {
  const next: Manifest = {
    // the schema is preserved, never recomputed: advancing it is `update` and
    // nothing else. Stamping MANIFEST_SCHEMA here would have `sync` declare a
    // migration it never ran — the same silent recompute the manifest forbids
    // for the projection mode, and it would leave `update` with nothing left to
    // migrate on a repository that had merely been synced.
    schema: manifest.schema,
    cliVersion: CLI_VERSION,
    project: manifest.project,
    harness: manifest.harness,
    packs: manifest.packs,
    ...(manifest.worktrees !== undefined
      ? { worktrees: manifest.worktrees }
      : {}),
    projections: { mode, hashes },
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

/**
 * The fingerprints of the projections still on disk once the removal is done.
 * A projection agentsdir does not own — hand-edited past recognition — is left
 * where it is, and its fingerprint has to be left in the manifest with it:
 * emptying `[projections.hashes]` while the files stay is how the record of
 * what was written gets lost, and with it any chance of recognizing those
 * copies as ours later.
 */
async function survivingHashes(
  root: string,
  hashes: Record<string, string>,
  removed: ReadonlySet<string>,
): Promise<Record<string, string>> {
  const surviving: Record<string, string> = {};
  for (const [path, hash] of Object.entries(hashes)) {
    if (removed.has(path)) {
      continue;
    }
    if (await entryExists(join(root, ...path.split("/")))) {
      surviving[path] = hash;
    }
  }
  return surviving;
}

async function applyPlannedFile(
  root: string,
  file: PlannedFile,
): Promise<void> {
  if (file.action === "ok" || file.content === undefined) {
    return;
  }
  // hook registries are written here, outside refreshProjections and before it:
  // without this guard a `.claude` symlink would rewrite the user's global
  // Claude Code settings, registering our hook there
  await ensureNoLinkedParent(root, file.path);
  const abs = join(root, ...file.path.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFileAtomic(abs, file.content);
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
