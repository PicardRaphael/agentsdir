import { lstat, stat } from "node:fs/promises";

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
