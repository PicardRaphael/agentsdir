import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
