import { renderOpenAiYaml, renderSkillIcon } from "../core/codex-metadata.js";
import { parseSkillMarkdown } from "../core/frontmatter.js";
import { hashSkillFiles } from "../core/validate.js";
import { CLI_VERSION } from "../version.js";
import { changelogPack } from "./changelog.js";
import { verificationPack } from "./verification.js";

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
}

/** Packs with installable content in this version. */
export const INSTALLABLE_PACKS = ["verification", "changelog"] as const;

export function getPackContent(name: string): PackContent | undefined {
  if (name === "verification") {
    return verificationPack();
  }
  if (name === "changelog") {
    return changelogPack();
  }
  return undefined;
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

/** Fresh skills-lock.json holding only the given agentsdir entries (init). */
export function renderLockSeed(
  entries: { skill: string; hash: string }[],
): string {
  const skills: Record<string, unknown> = {};
  for (const entry of [...entries].sort((a, b) =>
    a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0,
  )) {
    skills[entry.skill] = agentsdirLockEntry(entry.skill, entry.hash);
  }
  return `${JSON.stringify({ version: 1, skills }, null, 2)}\n`;
}

/** Authored files plus the derived Codex artifacts of the pack's skills. */
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
