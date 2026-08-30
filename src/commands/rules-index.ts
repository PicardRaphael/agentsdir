import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deriveRuleHook,
  renderRulesIndexContent,
  type RuleIndexEntry,
} from "../templates/agents-md.js";
import { EXIT_CODES } from "../exit-codes.js";
import { CliError } from "../core/errors.js";
import { readdirOrEmpty } from "../core/fs-utils.js";
import { upsertBlock } from "../core/managed-blocks.js";
import { ensureNoLinkedParent } from "../core/projections.js";

/**
 * The rules index of AGENTS.md, composed in one place. `init`, `sync`,
 * `add rule` and `pack add|remove` all need the same thing — the rules on disk,
 * plus the ones the command is about to write, minus the ones it removes — so
 * they share this composition rather than each re-deriving the entries.
 */
export const RULES_INDEX_BLOCK = "rules-index";

export interface RuleDelta {
  /** Rules this command is about to write (file name plus content). */
  add?: { file: string; content: string }[];
  /** Rule file names this command is removing. */
  remove?: string[];
}

/**
 * Rule file names under `.agents/rules/`, sorted; empty when there is none.
 *
 * Symlinks are skipped, not followed. A rule that is a link to a file outside
 * the repository would have its first line lifted into the `rules-index` block
 * of AGENTS.md — a file the user then commits and pushes. Reading only regular
 * files keeps outside content out of what gets versioned.
 */
export async function listRuleFiles(root: string): Promise<string[]> {
  // the per-entry lstat below only catches a rule that is a link; if the rules
  // directory itself is one, readdir walks through it and every outside file
  // lstats as a regular file
  await ensureNoLinkedParent(root, ".agents/rules/.");
  const dir = join(root, ".agents", "rules");
  const entries = await readdirOrEmpty(dir);
  const files: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    if ((await lstat(join(dir, entry)).catch(() => undefined))?.isFile()) {
      files.push(entry);
    }
  }
  return files;
}

/** Index entries for the rules on disk, adjusted by the command's delta. */
export async function collectRuleIndexEntries(
  root: string,
  delta: RuleDelta = {},
): Promise<RuleIndexEntry[]> {
  const sources = new Map<string, string>();
  for (const file of await listRuleFiles(root)) {
    sources.set(
      file,
      await readFile(join(root, ".agents", "rules", file), "utf8"),
    );
  }
  for (const entry of delta.add ?? []) {
    sources.set(entry.file, entry.content);
  }
  for (const file of delta.remove ?? []) {
    sources.delete(file);
  }
  return [...sources.keys()].sort().map((file) => ({
    file,
    hook: deriveRuleHook(sources.get(file) ?? ""),
  }));
}

/**
 * AGENTS.md with its rules index block brought up to date, or `undefined` when
 * it was already correct — the caller decides what a no-op means for its report.
 */
export async function planRulesIndex(
  root: string,
  delta: RuleDelta = {},
): Promise<{ current: string; next: string } | undefined> {
  let current: string;
  try {
    current = await readFile(join(root, "AGENTS.md"), "utf8");
  } catch {
    throw new CliError(
      "AGENTS.md is missing — run `agentsdir init` first.",
      EXIT_CODES.driftOrInvariant,
    );
  }
  const next = upsertBlock(
    current,
    RULES_INDEX_BLOCK,
    renderRulesIndexContent(await collectRuleIndexEntries(root, delta)),
    "html",
  );
  return next === current ? undefined : { current, next };
}
