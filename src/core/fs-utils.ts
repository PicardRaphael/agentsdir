import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { EXIT_CODES } from "../exit-codes.js";
import { CliError } from "./errors.js";

/**
 * The filesystem probes every command needs. They answer "is it there?" without
 * throwing, because absence is a normal answer everywhere in this CLI — a
 * missing file means "nothing to keep", not an error.
 */

/** True when the path exists, following symlinks. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when the path exists as an entry of its own, symlink included. */
export async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when the path exists and is a directory. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** True when the path exists and is a regular file. */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Entries of a directory, or none when it simply does not exist yet.
 *
 * The distinction matters more than it looks: an absent directory is a normal
 * answer ("no rules yet"), an unreadable one is a fault. Collapsing both into
 * an empty list makes a read failure look like emptiness, and the callers act
 * on emptiness by deleting the projections of the files they can no longer see.
 * Anything other than ENOENT is therefore raised, never swallowed.
 */
export async function readdirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new CliError(
      `Cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions or restore it — refusing to treat an unreadable directory as an empty one.`,
      EXIT_CODES.environmentOrUsage,
    );
  }
}

export interface WalkedFile {
  /** POSIX path relative to the walk root, carrying `prefix` when one was given. */
  rel: string;
  abs: string;
}

export interface WalkFilesOptions {
  /** Entry names never returned and never descended into. */
  exclude?: readonly string[];
  /** Prepended to every `rel`; `""` (the default) yields bare relative paths. */
  prefix?: string;
  /**
   * What an unreadable root means to the caller, as the tail of the message.
   *
   * Giving it also declares that an **absent** root is a normal answer, and
   * the walk returns nothing. Leaving it out declares the opposite: the
   * directory is expected to be there, and every error propagates untouched.
   * The two always travel together — a caller that tolerates absence is
   * exactly the one that must refuse to read unreadable as empty, which is how
   * live projections once got deleted on exit 0.
   */
  unreadable?: string;
}

/**
 * The one recursive directory walk of this CLI, sorted by name in **code
 * units** — not by locale. Three copies of it used to coexist with three
 * return shapes and three sets of exclusions, and the fingerprints of
 * `skills-lock.json` depend on this order: a `localeCompare` here would
 * re-order the hash input and invalidate every lock entry on a machine with
 * another locale.
 */
export async function walkFiles(
  absDir: string,
  options: WalkFilesOptions = {},
): Promise<WalkedFile[]> {
  const prefix = options.prefix ?? "";
  const exclude = options.exclude ?? [];
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (error) {
    if (options.unreadable === undefined) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new CliError(
      `Cannot read ${absDir} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions or restore it — ${options.unreadable}.`,
      EXIT_CODES.environmentOrUsage,
    );
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: WalkedFile[] = [];
  for (const entry of entries) {
    if (exclude.includes(entry.name)) {
      continue;
    }
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(abs, { ...options, prefix: rel })));
    } else if (entry.isFile()) {
      files.push({ rel, abs });
    }
  }
  return files;
}

/**
 * Writes a file so it is never observed half-written: the bytes land in a
 * sibling temporary file, then a single rename puts them in place. An
 * interrupted run leaves either the old content or the new one, never a
 * truncated file — which used to need its own repair path.
 *
 * The temporary file is a sibling because rename is only atomic within one
 * filesystem. `exclusive` refuses an existing target, the guarantee `init`
 * needs so a create can never write through a symlink.
 */
export async function writeFileAtomic(
  path: string,
  content: string | Buffer,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  if (options.exclusive === true && (await entryExists(path))) {
    const error: NodeJS.ErrnoException = new Error(
      `EEXIST: file already exists, open '${path}'`,
    );
    error.code = "EEXIST";
    throw error;
  }
  const transient = join(dirname(path), `.agentsdir-tmp-${randomUUID()}`);
  try {
    await writeFile(transient, content);
    await rename(transient, path);
  } catch (error) {
    await rm(transient, { force: true });
    throw error;
  }
}

/**
 * Resolves a repo-relative POSIX path against `root`, refusing anything that
 * escapes it.
 *
 * Paths reaching the engine come from files inside the repository — the
 * manifest's fingerprint keys, the lock's skill names, rule file names — and a
 * cloned repository is not trusted input. `path.join` normalises `..` instead
 * of rejecting it, so a crafted key was enough to make the CLI read, write or
 * delete outside the git root it resolved. Every derived path goes through
 * here, and the containment the product promises becomes a checked property
 * rather than an assumption.
 */
export function resolveInsideRepo(root: string, posixPath: string): string {
  const target = resolve(root, ...posixPath.split("/"));
  const inside = relative(resolve(root), target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new CliError(
      `Refusing to touch "${posixPath}": it resolves outside the repository. Some file in this repo declares a path that escapes the git root — inspect it before running agentsdir again.`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  return target;
}
