import { renderOpenAiYaml, renderSkillIcon } from "../core/codex-metadata.js";
import { parseSkillMarkdown } from "../core/frontmatter.js";
import { hashFileContent, hashSkillFiles } from "../core/skill-hash.js";
import { CLI_VERSION } from "../version.js";
import { changelogPack } from "./changelog.js";
import { creatorPack } from "./creator.js";
import { usagePack } from "./usage.js";
import { verificationPack } from "./verification.js";
import { worktreesPack } from "./worktrees.js";

/**
 * Content packs: deterministic renders installed into the target repo by
 * `init` and `pack add`, removed by `pack remove`. The authored files are the
 * source of truth; Codex artifacts are derived from the skill frontmatters
 * exactly like `add skill` and `sync` do.
 */
export interface PackFile {
  /** Repo-relative path, always with forward slashes. */
  path: string;
  content: string;
}

export interface PackContent {
  name: string;
  /** Authored files; rules and skills land in `.agents/`. */
  files: PackFile[];
  /** Skill folder names under `.agents/skills/` — drive artifacts and lock entries. */
  skills: string[];
  /** Rule file names under `.agents/rules/` — drive the rules index. */
  rules: string[];
  /** Paths kept as-is when they already exist in the target repo (never a collision). */
  keepExisting: string[];
  /**
   * Directories the pack's own scripts fill at run time — a journal, a cache.
   * They are not installed files: the install never writes them, `check` never
   * fingerprints them, and their presence is not a "local modification". They
   * are deleted by `pack remove`, which would otherwise leave behind exactly
   * the data the user uninstalled the pack to be rid of.
   */
  runtimeState?: string[];
}

/**
 * The single pack registry: adding a pack means adding one entry here and its
 * render module — no list to keep in sync elsewhere.
 */
const PACK_REGISTRY = {
  creator: creatorPack,
  verification: verificationPack,
  changelog: changelogPack,
  worktrees: worktreesPack,
  usage: usagePack,
} as const satisfies Record<string, () => PackContent>;

/** Packs with installable content in this version. */
export const INSTALLABLE_PACKS = Object.keys(
  PACK_REGISTRY,
) as (keyof typeof PACK_REGISTRY)[];

/** `core` is the always-installed baseline; it has no render module of its own. */
export const PACKS = ["core", ...INSTALLABLE_PACKS] as const;

export function getPackContent(name: string): PackContent | undefined {
  const render = PACK_REGISTRY[name as keyof typeof PACK_REGISTRY];
  return render === undefined ? undefined : render();
}

/** Fingerprint of a pack skill folder, computed from the rendered files (dry-run safe). */
export function packSkillHash(files: PackFile[], skill: string): string {
  const prefix = `.agents/skills/${skill}/`;
  const map: Record<string, Buffer> = {};
  for (const file of files) {
    if (file.path.startsWith(prefix)) {
      map[file.path.slice(prefix.length)] = Buffer.from(file.content, "utf8");
    }
  }
  return hashSkillFiles(map);
}

/** skills-lock.json entry of agentsdir-installed content (conventions §7). */
export function agentsdirLockEntry(
  skill: string,
  hash: string,
): Record<string, unknown> {
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
export function agentsdirFileLockEntry(hash: string): Record<string, unknown> {
  return {
    source: "agentsdir",
    sourceType: "agentsdir",
    installedVersion: CLI_VERSION,
    computedHash: hash,
  };
}

/**
 * The `files` lock entries of the files an install actually **wrote**. A file
 * the install kept as it found it (`keepExisting`, or an `init` that skipped an
 * existing path) is deliberately absent: locking it against a render agentsdir
 * never wrote would report it "locally modified" from the very first check, and
 * an invariant that fires on a correct repository teaches users to ignore it.
 */
export function packFileLockEntries(
  written: PackFile[],
): { path: string; hash: string }[] {
  return written
    .filter((file) => isLockableFile(file.path))
    .map((file) => ({ path: file.path, hash: hashFileContent(file.content) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The content whose provenance the lock tracks outside skill folders: the rules
 * and the shared scripts. Everything else a pack touches is either generated
 * from the source of truth (projections, the rules index) or owned by the user.
 */
export function isLockableFile(path: string): boolean {
  return (
    path.startsWith(".agents/rules/") ||
    path.startsWith(".agents/scripts/") ||
    // hook scripts a pack installs. Without this they were written and never
    // locked: `update` would not upgrade them, and `check` would not report a
    // local edit — the two promises the lock exists to keep. A hook the user
    // created with `add hook` belongs to nobody here and is never a pack file.
    path.startsWith(".agents/hooks/")
  );
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
export function renderLock(data: Record<string, unknown>): string {
  const rendered: Record<string, unknown> = {};
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
export function lockTable(
  data: unknown,
  table: "skills" | "files",
): Record<string, unknown> {
  const raw = (data as Record<string, unknown> | null)?.[table];
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function sortedByKey(table: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(table).sort()) {
    sorted[key] = table[key];
  }
  return sorted;
}

/** Fresh skills-lock.json holding only the given agentsdir entries (init). */
export function renderLockSeed(
  entries: { skill: string; hash: string }[],
  fileEntries: { path: string; hash: string }[] = [],
): string {
  const skills: Record<string, unknown> = {};
  for (const entry of entries) {
    skills[entry.skill] = agentsdirLockEntry(entry.skill, entry.hash);
  }
  const files: Record<string, unknown> = {};
  for (const entry of fileEntries) {
    files[entry.path] = agentsdirFileLockEntry(entry.hash);
  }
  // renderLock sorts both tables and drops an empty `files` — the absent table
  // is the documented "nothing tracked outside the skills"
  return renderLock({ version: 1, skills, files });
}

/** Authored files plus the derived Codex artifacts of the pack's skills. */
/**
 * Scripts the installed packs put in the repo for an *agent* to run — the
 * commands their skills spell out in a procedure. These are what the
 * `.claude/settings.json` allowlist covers: without a rule, Claude Code asks
 * before every run, which is the cascading-prompt flaw `docs/architecture.md`
 * lists among the ones this CLI fixes. Hook scripts are deliberately absent:
 * the harness runs those itself, outside the Bash tool, so no rule applies.
 */
export function packScriptPaths(packs: readonly string[]): string[] {
  const paths: string[] = [];
  for (const name of packs) {
    const pack = getPackContent(name);
    if (pack === undefined) {
      continue;
    }
    for (const file of pack.files) {
      // `.agents/hooks/` is excluded on purpose: the harness runs those itself,
      // outside the Bash tool, so no permission rule applies to them. The
      // comment above said so back when no pack shipped a hook; the `usage`
      // pack does, and without this filter its collectors would be announced
      // to the user as commands the agent may run.
      if (
        file.path.endsWith(".mjs") &&
        !file.path.startsWith(".agents/hooks/")
      ) {
        paths.push(file.path);
      }
    }
  }
  return paths.sort();
}

export function packInstallFiles(pack: PackContent): PackFile[] {
  const files = [...pack.files];
  for (const skill of pack.skills) {
    const source = pack.files.find(
      (file) => file.path === `.agents/skills/${skill}/SKILL.md`,
    );
    // pack content is authored in this repo: a missing SKILL.md is a bug
    const { frontmatter } = parseSkillMarkdown(source?.content ?? "");
    files.push(
      {
        path: `.agents/skills/${skill}/agents/openai.yaml`,
        content: renderOpenAiYaml(frontmatter),
      },
      {
        path: `.agents/skills/${skill}/assets/icon.svg`,
        content: renderSkillIcon(frontmatter),
      },
    );
  }
  return files;
}
