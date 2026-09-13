import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CLI_VERSION } from "../version.js";
import { CliError } from "./errors.js";
import { writeFileAtomic } from "./fs-utils.js";
import { computeSkillHash } from "./skill-hash.js";
import { EXIT_CODES } from "../exit-codes.js";

/**
 * `skills-lock.json`: one module for reading it, applying a delta to it,
 * re-locking what must be re-locked, and writing it.
 *
 * Three commands used to plan the same file, each its own way — `init` seeded
 * it, `pack` merged entries into it, `sync` re-locked its vendored entries —
 * and `update` read and wrote it on top. Every one of them re-derived the
 * shape checks, and the renderings had already drifted once: `init` seeded a
 * sorted table while `pack add` appended in pack order, so two repositories in
 * the same declared state held different bytes.
 *
 * The contract this module implements is `docs/conventions.md` §7. Two rules
 * of it are load-bearing and stated here because they are what the callers
 * must not re-decide: an `agentsdir` entry stays **pinned** to the version
 * that was installed (recomputing it would bless a local edit and lose the
 * protection `update` offers), while a `github` entry is **re-locked** to the
 * folder on disk, which is the deliberate local update `check` asks for.
 */

export const LOCK_FILE = "skills-lock.json";

/** A parsed lock. Deliberately loose: the shape is validated, not modelled. */
export type LockData = Record<string, unknown>;

export interface LockPlan {
  path: string;
  action: "created" | "updated" | "removed" | "ok";
  /** Bytes to write; absent on "removed" and "ok". */
  content?: string;
}

export interface LockDelta {
  /** Skill folders this command installs, with their fingerprint. */
  add?: { skill: string; hash: string }[];
  /** Skill folders it removes. */
  remove?: string[];
  /** Rules, scripts and hooks it writes outside any skill folder. */
  addFiles?: { path: string; hash: string }[];
  /** The same, removed. */
  removeFiles?: string[];
  /**
   * Re-lock every `github` entry against the folder on disk, with the files
   * this run is about to write standing in for those not yet on disk — so a
   * `--dry-run` computes the fingerprint the real run would.
   */
  relockVendored?: Record<string, Buffer>;
  /**
   * Entries this command replaces wholesale (`update` upgrading installed
   * content). `table` says which of the two tables the key belongs to.
   */
  replace?: { table: "skills" | "files"; key: string; entry: LockData }[];
}

/** Skill-name grammar; a key becomes a path segment, so it is checked twice. */
const NAME_SPEC = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * The parsed lock, or undefined when there is none. A malformed one is a
 * refusal, never an empty lock: treating it as empty would have the next write
 * drop every entry it could not read.
 */
export async function readLock(root: string): Promise<LockData | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(root, LOCK_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new CliError(
      `Cannot read ${LOCK_FILE} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions or restore it — refusing to rewrite a lock it cannot read.`,
      EXIT_CODES.environmentOrUsage,
    );
  }
  return parseLock(raw);
}

/** Shape validation, shared so the four callers refuse the same things. */
export function parseLock(raw: string): LockData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      `${LOCK_FILE} is not valid JSON — restore it from git history.`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      `${LOCK_FILE} must contain a JSON object — restore it from git history.`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  return parsed as LockData;
}

/**
 * What applying `delta` would write, without writing it. Returns `undefined`
 * when there is nothing to do and no lock to create — the caller then reports
 * nothing at all rather than an "ok" on a file that does not exist.
 */
export async function planLock(
  root: string,
  delta: LockDelta,
): Promise<LockPlan | undefined> {
  const add = delta.add ?? [];
  const remove = delta.remove ?? [];
  const addFiles = delta.addFiles ?? [];
  const removeFiles = delta.removeFiles ?? [];
  const replace = delta.replace ?? [];
  const relock = delta.relockVendored;
  const empty =
    add.length === 0 &&
    remove.length === 0 &&
    addFiles.length === 0 &&
    removeFiles.length === 0 &&
    replace.length === 0 &&
    relock === undefined;
  if (empty) {
    return undefined;
  }
  let raw: string | undefined;
  try {
    raw = await readFile(join(root, LOCK_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CliError(
        `Cannot read ${LOCK_FILE} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions or restore it — refusing to rewrite a lock it cannot read.`,
        EXIT_CODES.environmentOrUsage,
      );
    }
    raw = undefined;
  }
  // nothing on disk and nothing to add: a removal-only delta has no lock to
  // write, and seeding an empty one would be noise in a repo that asked for
  // none
  if (raw === undefined && add.length === 0 && addFiles.length === 0) {
    return undefined;
  }
  const data: LockData =
    raw === undefined ? { version: 1, skills: {} } : parseLock(raw);
  const skills = lockTable(data, "skills");
  const files = lockTable(data, "files");
  data["skills"] = skills;
  for (const entry of add) {
    skills[entry.skill] = agentsdirLockEntry(entry.skill, entry.hash);
  }
  for (const skill of remove) {
    delete skills[skill];
  }
  for (const entry of addFiles) {
    files[entry.path] = agentsdirFileLockEntry(entry.hash);
  }
  for (const path of removeFiles) {
    delete files[path];
  }
  for (const entry of replace) {
    (entry.table === "skills" ? skills : files)[entry.key] = entry.entry;
  }
  if (relock !== undefined) {
    await relockVendored(root, skills, relock);
  }
  data["files"] = files;
  if (Object.keys(skills).length === 0 && Object.keys(files).length === 0) {
    return raw === undefined
      ? undefined
      : { path: LOCK_FILE, action: "removed" };
  }
  const content = renderLock(data);
  if (content === raw) {
    return { path: LOCK_FILE, action: "ok", content };
  }
  return {
    path: LOCK_FILE,
    action: raw === undefined ? "created" : "updated",
    content,
  };
}

/** The only function that writes `skills-lock.json`. */
export async function applyLockPlan(
  root: string,
  plan: LockPlan | undefined,
): Promise<void> {
  if (plan === undefined || plan.action === "ok") {
    return;
  }
  const path = join(root, LOCK_FILE);
  if (plan.action === "removed") {
    await rm(path, { force: true });
    return;
  }
  await writeFileAtomic(path, plan.content ?? "");
}

/**
 * `github` entries re-locked to the folder on disk; `agentsdir` entries left
 * exactly as they are. That asymmetry IS the protection `update` offers: a
 * recomputed `agentsdir` fingerprint would bless whatever the user edited, and
 * the next `update` would overwrite precisely what they meant to keep.
 */
async function relockVendored(
  root: string,
  skills: LockData,
  overlay: Record<string, Buffer>,
): Promise<void> {
  for (const [name, entryRaw] of Object.entries(skills)) {
    const entry = entryRaw as LockData;
    if (entry["sourceType"] === "agentsdir") {
      continue;
    }
    // the key becomes a path segment that gets read and hashed; `check`
    // already refused an invalid one, and so does this
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
}

/** skills-lock.json entry of agentsdir-installed content (conventions §7). */
export function agentsdirLockEntry(skill: string, hash: string): LockData {
  return {
    source: "agentsdir",
    sourceType: "agentsdir",
    installedVersion: CLI_VERSION,
    skillPath: `.agents/skills/${skill}/SKILL.md`,
    computedHash: hash,
  };
}

/**
 * Lock entry of an installed file that belongs to no skill folder — the generic
 * rules of `.agents/rules/` and the shared scripts of `.agents/scripts/` a pack
 * writes. Same `sourceType` as the meta-skills, because it is the same promise:
 * `update` upgrades what is intact and never overwrites what the user changed.
 */
export function agentsdirFileLockEntry(hash: string): LockData {
  return {
    source: "agentsdir",
    sourceType: "agentsdir",
    installedVersion: CLI_VERSION,
    computedHash: hash,
  };
}

/**
 * The single way a `skills-lock.json` is rendered. Every writer goes through
 * it, so two repositories in the same declared state hold the same bytes.
 *
 * They did not: `init` seeded a sorted lock while `pack add` appended to the
 * `skills` table in pack order (it already sorted `files`, which is what made
 * the asymmetry easy to miss). A repository that installed `creator` at `init`
 * and one that added it afterwards therefore differed by key order alone —
 * a generated file with two renderings, against the byte-for-byte determinism
 * the fingerprints and `check` are built on.
 */
export function renderLock(data: LockData): string {
  const rendered: LockData = {};
  for (const [key, value] of Object.entries(data)) {
    if (key !== "skills" && key !== "files") {
      rendered[key] = value;
    }
  }
  rendered["skills"] = sortedByKey(lockTable(data, "skills"));
  const files = lockTable(data, "files");
  // an absent `files` table is valid and means "nothing tracked outside the
  // skills" — writing it as `{}` would be a second rendering of one state
  if (Object.keys(files).length > 0) {
    rendered["files"] = sortedByKey(files);
  }
  return `${JSON.stringify(rendered, null, 2)}\n`;
}

/** One table of a parsed lock, or an empty one when it is absent or malformed. */
export function lockTable(data: unknown, table: "skills" | "files"): LockData {
  const raw = (data as LockData | null)?.[table];
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as LockData)
    : {};
}

function sortedByKey(table: LockData): LockData {
  const sorted: LockData = {};
  for (const key of Object.keys(table).sort()) {
    sorted[key] = table[key];
  }
  return sorted;
}
