import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineCommand } from "citty";
import * as prompts from "@clack/prompts";
import { unifiedDiff } from "../core/diff.js";
import { asUserFacingError, CliError } from "../core/errors.js";
import { writeFileAtomic } from "../core/fs-utils.js";
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  readManifest,
  renderManifest,
  type Manifest,
  type ProjectionMode,
} from "../core/manifest.js";
import {
  planSchemaMigration,
  type SchemaMigration,
} from "../core/migrations.js";
import { ensureNoLinkedParent } from "../core/projections.js";
import { resolveRepoRoot } from "../core/repo.js";
import {
  computeSkillHash,
  hashFileContent,
  listSkillFiles,
} from "../core/skill-hash.js";
import { NAME_SPEC, type Violation } from "../core/validate.js";
import { EXIT_CODES, type ExitCode } from "../exit-codes.js";
import {
  agentsdirFileLockEntry,
  agentsdirLockEntry,
  getPackContent,
  packInstallFiles,
  packSkillHash,
  type PackFile,
} from "../packs/index.js";
import { isInteractive } from "./add-common.js";
import { runSync, type SyncAction, type SyncChange } from "./sync.js";

/**
 * `update` is the key to the lock. `skills-lock.json` has always distinguished
 * `sourceType: "agentsdir"` — content the CLI installed — from vendored
 * content, so that an upgrade could replace the first without touching the
 * second. Until this command existed, nothing ever read that distinction.
 *
 * Two jobs, in this order: walk the declared schema transformations
 * (`core/migrations.ts`), then bring the installed content up to the version
 * this CLI renders. The whole plan is computed before a single byte is
 * written — a migration interrupted halfway leaves a repository in a state no
 * command knows how to describe.
 */

/** How a locally modified file whose upstream also changed was settled. */
export type ConflictResolution = "kept" | "replaced" | "undecided";

export interface UpdateConflict {
  /** Repo-relative path of the file, or of the skill folder. */
  path: string;
  /** Unified diff, local against the rendering this CLI installs. */
  diff: string;
  resolution: ConflictResolution;
}

export interface UpdateResult {
  changes: SyncChange[];
  /** The schema steps this run walks, in order; empty when already current. */
  migrations: SchemaMigration[];
  /** Locally modified, upstream unchanged: kept, reported, never blocking. */
  preserved: string[];
  conflicts: UpdateConflict[];
  /** What `--json` puts in `errors`: the conflicts, plus the preserved notes. */
  violations: Violation[];
  exitCode: ExitCode;
  mode: ProjectionMode;
}

/**
 * Settles one conflict. Injected rather than decided inside `runUpdate`: only
 * the CLI knows whether there is a terminal to ask, and a decision procedure
 * that cannot be substituted is a decision procedure no test ever exercises.
 */
export type ConflictResolver = (
  conflict: UpdateConflict,
) => Promise<ConflictResolution>;

export interface UpdateOptions {
  dryRun: boolean;
  /**
   * Absent — a script, `--json`, `--dry-run`, no terminal — every conflict
   * stays undecided: nothing is overwritten, nothing is acknowledged either,
   * and the run ends on exit 1, the human decision it needed never asked for.
   */
  resolve?: ConflictResolver;
}

/** One piece of installed content, with everything needed to classify it. */
interface Installed {
  /** Repo-relative path of the file, or of the skill folder. */
  path: string;
  /** Fingerprint recorded at install time. */
  locked: string;
  /** Fingerprint of what is on disk now. */
  actual: string;
  /** Fingerprint of what this CLI renders today. */
  upstream: string;
  /** The new rendering, keyed by repo-relative path. */
  render: Map<string, string>;
  /** What is on disk now, same keys — the left-hand side of the diff. */
  local: Map<string, string>;
  /** Files of the folder on disk, repo-relative; a lone file is just itself. */
  onDisk: string[];
  /** Lock table this entry belongs to, and its key in it. */
  lock: { table: "skills" | "files"; key: string };
}

/**
 * Migrates an installation to the schema and the content this CLI ships.
 *
 * User content is out of reach by construction: the only files this command
 * can write are the ones a `sourceType: "agentsdir"` lock entry names, and the
 * only structure it touches is what a migration step declares. A `SKILL.md`
 * the user wrote, a rule they authored, the body of their `AGENTS.md` are
 * named by nothing here.
 */
export async function runUpdate(
  root: string,
  options: UpdateOptions,
): Promise<UpdateResult> {
  const manifest = await readManifest(root);
  const mode = manifest.projections.mode;
  // throws before anything is written when a step is missing (exit 1)
  const migrations = planSchemaMigration(manifest.schema);
  const installed = await collectInstalled(root, manifest);

  const changes: SyncChange[] = [];
  const preserved: string[] = [];
  const conflicts: UpdateConflict[] = [];
  const upgrades: Installed[] = [];
  const acknowledged: Installed[] = [];
  for (const entry of installed) {
    if (entry.actual === entry.locked) {
      if (entry.upstream === entry.locked) {
        changes.push({ path: entry.path, action: "ok" });
        continue;
      }
      // intact: every file in there is ours, so replacing the folder wholesale
      // — removals included — cannot take anything the user wrote
      upgrades.push(entry);
      continue;
    }
    if (entry.upstream === entry.locked) {
      // edited locally, and this CLI renders exactly what was installed: there
      // is nothing to propose, and `check` already reports it as information
      preserved.push(entry.path);
      changes.push({ path: entry.path, action: "ok" });
      continue;
    }
    conflicts.push({
      path: entry.path,
      diff: renderConflictDiff(entry),
      resolution: "undecided",
    });
  }

  await resolveConflicts(conflicts, options);
  for (const conflict of conflicts) {
    const entry = installed.find(
      (candidate) => candidate.path === conflict.path,
    );
    if (entry === undefined) {
      continue;
    }
    if (conflict.resolution === "replaced") {
      upgrades.push(entry);
    } else if (conflict.resolution === "kept") {
      // the user answered "mine": record that answer against this version, so
      // the same question is not asked again until upstream moves once more
      acknowledged.push(entry);
    }
  }

  for (const entry of upgrades) {
    for (const change of planWrites(entry)) {
      changes.push(change);
    }
  }
  const lock = await planLock(root, upgrades, acknowledged);
  if (lock !== undefined) {
    changes.push({ path: "skills-lock.json", action: "updated" });
  }
  const nextManifest: Manifest = { ...manifest, schema: MANIFEST_SCHEMA };
  if (migrations.length > 0) {
    changes.push({ path: MANIFEST_FILE, action: "updated" });
  }

  const overlay: Record<string, Buffer> = {};
  for (const entry of upgrades) {
    for (const [path, content] of entry.render) {
      overlay[path] = Buffer.from(content, "utf8");
    }
  }
  if (!options.dryRun) {
    for (const entry of upgrades) {
      await applyUpgrade(root, entry);
    }
    if (lock !== undefined) {
      await writeFile(join(root, "skills-lock.json"), lock, "utf8");
    }
    if (migrations.length > 0) {
      await writeFile(
        join(root, MANIFEST_FILE),
        renderManifest(nextManifest),
        "utf8",
      );
    }
  }
  // the closing sync: every managed block and every projection regenerated
  // from the source of truth, which is what a migration step declares as its
  // scope. In a dry run the disk still holds the old content, so the upgraded
  // renderings are handed over as an overlay — otherwise the plan would
  // announce as "ok" every projection the real run rewrites.
  const sync = await runSync(root, {
    dryRun: options.dryRun,
    ...(options.dryRun ? { sourceOverlay: overlay } : {}),
  });
  if (sync.violations.length > 0) {
    return {
      changes: [],
      migrations,
      preserved,
      conflicts,
      violations: sync.violations,
      exitCode: sync.exitCode,
      mode,
    };
  }
  const undecided = conflicts.filter(
    (conflict) => conflict.resolution === "undecided",
  );
  return {
    changes: mergeChanges(changes, sync.changes),
    migrations,
    preserved,
    conflicts,
    violations: [
      ...undecided.map((conflict): Violation => ({
        path: conflict.path,
        rule: "update-merge-required",
        message: `agentsdir-installed content was modified locally and this CLI ships a new version — nothing was overwritten. Run \`agentsdir update\` in a terminal to decide, or apply the diff by hand.\n${conflict.diff}`,
        severity: "error",
      })),
      ...preserved.map((path): Violation => ({
        path,
        rule: "update-local-change",
        message:
          "agentsdir-installed content modified locally, and this CLI installs the same version — kept as is, nothing to merge.",
        severity: "info",
      })),
    ],
    exitCode:
      undecided.length > 0 ? EXIT_CODES.driftOrInvariant : EXIT_CODES.ok,
    mode: sync.mode,
  };
}

/**
 * Everything a `sourceType: "agentsdir"` lock entry names, paired with the
 * rendering this CLI would install for it today.
 *
 * The lock is what drives this, never the pack rendering: a pack file absent
 * from the lock was kept as the repository already had it (`keepExisting`, or
 * an `init` that skipped an existing path), and upgrading it would overwrite
 * content agentsdir never wrote.
 */
async function collectInstalled(
  root: string,
  manifest: Manifest,
): Promise<Installed[]> {
  const renders = new Map<string, PackFile[]>();
  for (const name of manifest.packs.installed) {
    const pack = getPackContent(name);
    if (pack === undefined) {
      continue; // `core` has no render module of its own
    }
    renders.set(name, packInstallFiles(pack));
  }
  const bySkill = new Map<string, PackFile[]>();
  const byFile = new Map<string, string>();
  for (const files of renders.values()) {
    for (const file of files) {
      byFile.set(file.path, file.content);
      const match = /^\.agents\/skills\/([^/]+)\//.exec(file.path);
      if (match?.[1] !== undefined) {
        bySkill.set(match[1], [...(bySkill.get(match[1]) ?? []), file]);
      }
    }
  }
  let raw: string;
  try {
    raw = await readFile(join(root, "skills-lock.json"), "utf8");
  } catch {
    return []; // no lock: nothing was ever installed under our name
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CliError(
      "skills-lock.json is not valid JSON — restore it from git history.",
      EXIT_CODES.driftOrInvariant,
    );
  }
  const installed: Installed[] = [];
  for (const [name, entry] of agentsdirEntries(data, "skills")) {
    // the key becomes a path segment; validateRepo refuses an invalid one and
    // so does this, before any disk access
    if (!NAME_SPEC.test(name)) {
      continue;
    }
    const files = bySkill.get(name);
    if (files === undefined) {
      continue; // installed by a pack this repo no longer declares
    }
    const dir = join(root, ".agents", "skills", name);
    const path = `.agents/skills/${name}`;
    let actual: string;
    let onDisk: string[];
    let local: Map<string, string>;
    try {
      actual = await computeSkillHash(dir);
      onDisk = (await listSkillFiles(dir)).map((rel) => `${path}/${rel}`);
      local = new Map(
        await Promise.all(
          onDisk.map(
            async (file) =>
              [
                file,
                await readFile(join(root, ...file.split("/")), "utf8"),
              ] as [string, string],
          ),
        ),
      );
    } catch {
      throw new CliError(
        `Locked skill folder ${path}/ is missing — restore it, or drop its entry from skills-lock.json. Nothing was written.`,
        EXIT_CODES.driftOrInvariant,
      );
    }
    installed.push({
      path,
      locked: entry,
      actual,
      upstream: packSkillHash(files, name),
      render: new Map(files.map((file) => [file.path, file.content])),
      local,
      onDisk,
      lock: { table: "skills", key: name },
    });
  }
  for (const [path, entry] of agentsdirEntries(data, "files")) {
    const content = byFile.get(path);
    if (content === undefined) {
      continue; // installed by a pack this repo no longer declares
    }
    let current: Buffer;
    try {
      current = await readFile(join(root, ...path.split("/")));
    } catch {
      throw new CliError(
        `Locked file ${path} is missing — restore it, or drop its entry from skills-lock.json. Nothing was written.`,
        EXIT_CODES.driftOrInvariant,
      );
    }
    installed.push({
      path,
      locked: entry,
      actual: hashFileContent(current),
      upstream: hashFileContent(content),
      render: new Map([[path, content]]),
      local: new Map([[path, current.toString("utf8")]]),
      onDisk: [path],
      lock: { table: "files", key: path },
    });
  }
  return installed.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/** `[key, computedHash]` of the `sourceType: "agentsdir"` entries of a table. */
function agentsdirEntries(
  data: unknown,
  table: "skills" | "files",
): [string, string][] {
  const raw = (data as Record<string, unknown>)[table];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [];
  }
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = (value ?? {}) as Record<string, unknown>;
    const hash = entry["computedHash"];
    if (entry["sourceType"] === "agentsdir" && typeof hash === "string") {
      entries.push([key, hash]);
    }
  }
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The upstream diff of a conflict: every file of the entry that differs. */
function renderConflictDiff(entry: Installed): string {
  const paths = [...new Set([...entry.onDisk, ...entry.render.keys()])].sort();
  const diffs: string[] = [];
  for (const path of paths) {
    const upstream = entry.render.get(path) ?? "";
    const diff = unifiedDiff(path, entry.local.get(path) ?? "", upstream);
    if (diff !== "") {
      diffs.push(diff);
    }
  }
  return diffs.join("\n");
}

/**
 * The write plan of one upgraded entry: the new files, minus what it drops.
 * Compared byte for byte against the local content, as every other command
 * here does — an upgraded skill usually reshapes one file out of five, and a
 * plan announcing the other four as changed is a plan nobody can check.
 */
function planWrites(entry: Installed): SyncChange[] {
  const changes: SyncChange[] = [];
  const known = new Set(entry.onDisk);
  for (const path of [...entry.render.keys()].sort()) {
    const action: SyncAction = !known.has(path)
      ? "created"
      : entry.local.get(path) === entry.render.get(path)
        ? "ok"
        : "updated";
    changes.push({ path, action });
  }
  for (const path of entry.onDisk) {
    if (!entry.render.has(path)) {
      changes.push({ path, action: "removed" });
    }
  }
  return changes.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/** Writes one upgraded entry. Safe only because the entry was proven intact. */
async function applyUpgrade(root: string, entry: Installed): Promise<void> {
  for (const path of entry.onDisk) {
    if (!entry.render.has(path)) {
      await rm(join(root, ...path.split("/")), { force: true });
    }
  }
  for (const [path, content] of entry.render) {
    await ensureNoLinkedParent(root, path);
    const abs = join(root, ...path.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFileAtomic(abs, Buffer.from(content, "utf8"));
  }
}

/**
 * The lock with the upgraded and acknowledged entries re-pinned to this CLI
 * version. `sync` deliberately never recomputes an `agentsdir` fingerprint —
 * that is the protection this command exists to lift — so `update` writes
 * those entries itself, before handing over to `sync`.
 */
async function planLock(
  root: string,
  upgrades: Installed[],
  acknowledged: Installed[],
): Promise<string | undefined> {
  if (upgrades.length === 0 && acknowledged.length === 0) {
    return undefined;
  }
  const raw = await readFile(join(root, "skills-lock.json"), "utf8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  const repin = (entry: Installed, hash: string): void => {
    const table = data[entry.lock.table] as Record<string, unknown>;
    table[entry.lock.key] =
      entry.lock.table === "skills"
        ? agentsdirLockEntry(entry.lock.key, hash)
        : agentsdirFileLockEntry(hash);
  };
  for (const entry of upgrades) {
    repin(entry, entry.upstream);
  }
  for (const entry of acknowledged) {
    repin(entry, entry.actual);
  }
  const rendered = `${JSON.stringify(data, null, 2)}\n`;
  return rendered === raw ? undefined : rendered;
}

/**
 * Settles every conflict through the injected resolver. A dry run decides
 * nothing by definition: it reports the plan a run that asks nobody would
 * carry out, exit code included.
 */
async function resolveConflicts(
  conflicts: UpdateConflict[],
  options: UpdateOptions,
): Promise<void> {
  const resolve = options.resolve;
  if (conflicts.length === 0 || options.dryRun || resolve === undefined) {
    return;
  }
  for (const conflict of conflicts) {
    conflict.resolution = await resolve(conflict);
  }
}

/**
 * The terminal resolver: the diff on stderr — stdout belongs to the report —
 * then the question. A cancelled prompt leaves this conflict and every one
 * after it undecided, which is the outcome that writes nothing.
 */
function askResolver(): ConflictResolver {
  let cancelled = false;
  return async (conflict) => {
    if (cancelled) {
      return "undecided";
    }
    console.error(conflict.diff);
    const answer = await prompts.select({
      message: `${conflict.path} was modified locally and agentsdir ships a new version.`,
      options: [
        { value: "kept", label: "Keep mine (recorded, not asked again)" },
        { value: "replaced", label: "Take the agentsdir version" },
      ],
    });
    if (prompts.isCancel(answer)) {
      cancelled = true;
      return "undecided";
    }
    return answer as ConflictResolution;
  };
}

/** Sync's plan on top of ours; ours wins, it describes the write that led there. */
function mergeChanges(own: SyncChange[], sync: SyncChange[]): SyncChange[] {
  const byPath = new Map<string, SyncChange>();
  for (const change of [...sync, ...own]) {
    const previous = byPath.get(change.path);
    // "ok" never overrides a real action: a file update wrote and its
    // projection was already in step is still an update
    if (previous !== undefined && change.action === "ok") {
      continue;
    }
    byPath.set(change.path, change);
  }
  return [...byPath.values()].sort((a, b) => {
    const rank = (change: SyncChange): number =>
      change.action === "removed" ? 0 : 1;
    return (
      rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    );
  });
}

export function renderUpdateReport(
  result: UpdateResult,
  options: { dryRun: boolean },
): string {
  if (
    result.violations.some((violation) => violation.severity === "error") &&
    result.changes.length === 0
  ) {
    return [
      ...result.violations.map(
        (violation) =>
          `drift  ${violation.path} · ${violation.rule} · ${violation.message}`,
      ),
      "Update aborted — fix the invariants above; nothing was written.",
    ].join("\n");
  }
  const lines: string[] = [];
  if (result.migrations.length === 0) {
    lines.push("Manifest schema is already current — no structural migration.");
  } else {
    lines.push("Schema migration:");
    for (const step of result.migrations) {
      lines.push(`  ${step.from} -> ${step.to}  ${step.summary}`);
    }
  }
  lines.push("");
  lines.push(
    options.dryRun ? "Dry run — nothing was written. Full plan:" : "Updated:",
  );
  for (const change of result.changes) {
    lines.push(`  ${change.action.padEnd(7)}  ${change.path}`);
  }
  if (result.preserved.length > 0) {
    lines.push("");
    lines.push("Kept (modified locally, this CLI installs the same version):");
    for (const path of result.preserved) {
      lines.push(`  ${path}`);
    }
  }
  const undecided = result.conflicts.filter(
    (conflict) => conflict.resolution === "undecided",
  );
  for (const conflict of undecided) {
    lines.push("");
    lines.push(
      `Merge needed — ${conflict.path} was modified locally and agentsdir ships a new version:`,
    );
    lines.push(conflict.diff);
  }
  if (undecided.length > 0) {
    lines.push("");
    lines.push(
      "Nothing was overwritten. Run `agentsdir update` in a terminal to decide, or apply the diff by hand.",
    );
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

export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description:
      "Migrate the manifest schema and upgrade the content agentsdir installed",
  },
  args: {
    "dry-run": {
      type: "boolean",
      description: "Print the full plan without touching the disk",
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
      // a prompt would break the --json contract, a dry run answers nothing by
      // definition, and a script has nobody to ask
      const interactive = !json && !dryRun && isInteractive();
      const result = await runUpdate(root, {
        dryRun,
        ...(interactive ? { resolve: askResolver() } : {}),
      });
      if (json) {
        console.log(
          JSON.stringify({
            command: "update",
            mode: result.mode,
            changes: result.changes,
            errors: result.violations,
            exitCode: result.exitCode,
          }),
        );
      } else {
        console.log(renderUpdateReport(result, { dryRun }));
      }
      process.exitCode = result.exitCode;
    } catch (rawError) {
      const error = asUserFacingError(rawError);
      if (error !== undefined) {
        if (json) {
          console.log(
            JSON.stringify({
              command: "update",
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
