import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { walkFiles } from "./fs-utils.js";

/**
 * The fingerprint of a skill folder, per the algorithm documented in
 * `docs/conventions.md` §7. It lives on its own rather than inside the
 * validator: `pack add` and `sync` fingerprint folders to fill the lock, which
 * has nothing to do with checking invariants.
 */

/**
 * Fingerprint read from disk: sorted relative paths (excluding .git and
 * node_modules), one rolling sha256 fed with each path then its content. The
 * optional overlay (skill-relative POSIX paths) stands in for files about to be
 * written, so `sync --dry-run` computes the same fingerprint as the real run.
 */
export async function computeSkillHash(
  dir: string,
  overlay: Record<string, Buffer> = {},
): Promise<string> {
  const walked = await skillFiles(dir);
  const files: Record<string, Buffer> = {};
  for (const rel of walked) {
    files[rel] = overlay[rel] ?? (await readFile(join(dir, ...rel.split("/"))));
  }
  for (const [rel, content] of Object.entries(overlay)) {
    files[rel] = content;
  }
  return hashSkillFiles(files);
}

/**
 * The files the fingerprint above is computed from: skill-relative POSIX paths,
 * sorted, `.git` and `node_modules` excluded. `update` needs the same list to
 * diff an installed folder against its new rendering and to remove what the
 * new one no longer ships — deriving it a second time is how the two would
 * eventually disagree on what belongs to the skill.
 */
export function listSkillFiles(dir: string): Promise<string[]> {
  return skillFiles(dir);
}

/**
 * Same fingerprint, computed from in-memory contents (skill-relative POSIX
 * paths) — for folders that are not on disk yet (`pack add --dry-run`).
 */
export function hashSkillFiles(files: Record<string, Buffer>): string {
  const paths = Object.keys(files).sort(pathCompare);
  const hash = createHash("sha256");
  for (const rel of paths) {
    hash.update(rel);
    hash.update(files[rel] ?? Buffer.alloc(0));
  }
  return hash.digest("hex");
}

/**
 * Fingerprint of one installed file — the `files` entries of the lock, which
 * track the rules and scripts a pack writes outside any skill folder. A lone
 * file has no folder to walk and no path to mix in: the sha256 of its bytes is
 * the whole fingerprint, and it stays stable whatever the pack renames.
 */
export function hashFileContent(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Segment-wise path order — the exact order the walk produces, so merging
 * overlay paths never reorders the fingerprint input of files already on disk.
 */
function pathCompare(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const x = left[index] ?? "";
    const y = right[index] ?? "";
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return left.length - right.length;
}

/**
 * The files a skill folder contributes to its fingerprint: sorted, `.git` and
 * `node_modules` excluded. An absent folder is NOT an empty one here — the
 * caller asked for the fingerprint of something it believes exists, and an
 * empty hash would silently certify a folder that is gone.
 */
function skillFiles(dir: string): Promise<string[]> {
  return walkFiles(dir, { exclude: SKILL_HASH_EXCLUDED }).then((files) =>
    files.map((file) => file.rel),
  );
}

const SKILL_HASH_EXCLUDED = [".git", "node_modules"] as const;
