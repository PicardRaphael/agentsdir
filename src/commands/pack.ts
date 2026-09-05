import {
  entryExists,
  resolveInsideRepo,
  writeFileAtomic,
} from "../core/fs-utils.js";
import { readdir, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineCommand } from "citty";
import { CliError } from "../core/errors.js";
import {
  MANIFEST_FILE,
  readManifest,
  renderManifest,
  type Manifest,
} from "../core/manifest.js";
import { resolveRepoRoot } from "../core/repo.js";
import { EXIT_CODES } from "../exit-codes.js";
import {
  agentsdirFileLockEntry,
  agentsdirLockEntry,
  getPackContent,
  INSTALLABLE_PACKS,
  packFileLockEntries,
  packInstallFiles,
  packSkillHash,
  type PackContent,
  type PackFile,
} from "../packs/index.js";
import {
  renderGeneratorReport,
  resyncProjections,
  runGeneratorCli,
  type GeneratorChange,
  type GeneratorResult,
} from "./add-common.js";
import { planRulesIndex } from "../core/rules-index.js";

export interface PackResult extends GeneratorResult {
  /** Human notes (kept files…) — stderr, never stdout. */
  notes: string[];
}

/** Usage error (exit 2) unless the pack has installable content. */
export function resolveInstallablePack(name: string): PackContent {
  const pack = getPackContent(name);
  if (pack !== undefined) {
    return pack;
  }
  if (name === "core") {
    throw new CliError(
      'Pack "core" is the base installation: `init` installs it and it cannot be added or removed separately.',
    );
  }
  throw new CliError(
    `Unknown pack "${name}" (available: ${INSTALLABLE_PACKS.join(", ")}).`,
  );
}

/**
 * Installs a pack: authored files, derived Codex artifacts, rules-index
 * entry, agentsdir lock entry, manifest. The whole plan is computed before
 * any write — a collision or an invalid state writes nothing.
 */
export async function runPackAdd(
  root: string,
  name: string,
  options: { dryRun: boolean },
): Promise<PackResult> {
  const pack = resolveInstallablePack(name);
  const manifest = await readManifest(root);
  if (manifest.packs.installed.includes(name)) {
    throw new CliError(
      `Pack "${name}" is already installed — \`agentsdir sync\` regenerates its projections.`,
    );
  }
  for (const skill of pack.skills) {
    // lstat, not stat: a broken symlink reads as absent to stat, and the
    // write below would then create the file through it, outside the repo
    if (await entryExists(join(root, ".agents", "skills", skill))) {
      throw new CliError(
        `.agents/skills/${skill}/ already exists and would collide with pack "${name}". Move it away or rename it, then retry.`,
      );
    }
  }
  const files = packInstallFiles(pack);
  const changes: GeneratorChange[] = [];
  const notes: string[] = [];
  const toWrite: PackFile[] = [];
  for (const file of files) {
    if (await entryExists(join(root, ...file.path.split("/")))) {
      if (pack.keepExisting.includes(file.path)) {
        notes.push(`${file.path} already exists — kept as is.`);
        continue;
      }
      throw new CliError(
        `${file.path} already exists and would collide with pack "${name}". Move it away or rename it, then retry.`,
      );
    }
    toWrite.push(file);
    changes.push({ path: file.path, action: "created" });
  }
  const agentsMd = await planRulesIndexWith(root, {
    add: pack.rules.map((rule) => ({
      file: rule,
      content: contentOf(files, `.agents/rules/${rule}`),
    })),
    remove: [],
  });
  if (agentsMd !== undefined) {
    changes.push({ path: "AGENTS.md", action: "updated" });
  }
  const lock = await planLockWith(root, {
    add: pack.skills.map((skill) => ({
      skill,
      hash: packSkillHash(files, skill),
    })),
    remove: [],
    // toWrite, not files: a `keepExisting` path was kept as the repo had it and
    // is none of ours to fingerprint
    addFiles: packFileLockEntries(toWrite),
  });
  if (lock !== undefined) {
    changes.push({ path: "skills-lock.json", action: lock.action });
  }
  const nextManifest: Manifest = {
    ...manifest,
    packs: { installed: [...manifest.packs.installed, name] },
    // worktrees: seed the empty extension section so the extension point is
    // visible in the file the user opens (the rule documents the values)
    ...(name === "worktrees" && manifest.worktrees === undefined
      ? { worktrees: { setup: [], cleanup: [] } }
      : {}),
  };
  changes.push({ path: MANIFEST_FILE, action: "updated" });
  if (!options.dryRun) {
    for (const file of toWrite) {
      const abs = join(root, ...file.path.split("/"));
      await mkdir(dirname(abs), { recursive: true });
      await writeFileAtomic(abs, file.content, { exclusive: true });
    }
    if (agentsMd !== undefined) {
      await writeFile(join(root, "AGENTS.md"), agentsMd, "utf8");
    }
    if (lock !== undefined && lock.content !== undefined) {
      await writeFile(join(root, "skills-lock.json"), lock.content, "utf8");
    }
    await writeFile(
      join(root, MANIFEST_FILE),
      renderManifest(nextManifest),
      "utf8",
    );
  }
  return {
    changes: sortChanges([
      ...changes,
      // the pack's skills and rules must reach the harnesses right away
      ...(await resyncProjections(root, nextManifest, {
        ...options,
        overlay: Object.fromEntries(
          toWrite.map((file) => [file.path, file.content]),
        ),
      })),
    ]),
    notes,
    exitCode: EXIT_CODES.ok,
    mode: manifest.projections.mode,
  };
}

/**
 * Removes a pack: its files, index entry, lock entry, manifest entry — and,
 * in copy mode, the projection copies the manifest fingerprints prove are
 * ours. Refuses (exit 1, nothing removed) when pack files were modified
 * locally, unless --force.
 */
export async function runPackRemove(
  root: string,
  name: string,
  options: { force: boolean; dryRun: boolean },
): Promise<PackResult> {
  const pack = resolveInstallablePack(name);
  const manifest = await readManifest(root);
  if (!manifest.packs.installed.includes(name)) {
    throw new CliError(`Pack "${name}" is not installed.`);
  }
  const files = packInstallFiles(pack);
  const expected = new Map(files.map((file) => [file.path, file.content]));
  const modified: string[] = [];
  const present: string[] = [];
  for (const [path, content] of expected) {
    let current: string;
    try {
      current = await readFile(join(root, ...path.split("/")), "utf8");
    } catch {
      continue; // already gone
    }
    present.push(path);
    if (current !== content) {
      modified.push(path);
    }
  }
  for (const skill of pack.skills) {
    const folder = `.agents/skills/${skill}`;
    for (const rel of await walkFiles(join(root, ...folder.split("/")))) {
      const path = `${folder}/${rel}`;
      if (!expected.has(path)) {
        present.push(path);
        modified.push(`${path} (added locally)`);
      }
    }
  }
  if (modified.length > 0 && !options.force) {
    throw new CliError(
      [
        `Pack "${name}" files were modified locally:`,
        ...modified.map((path) => `  - ${path}`),
        "Nothing was removed. Re-run with --force to remove them anyway.",
      ].join("\n"),
      EXIT_CODES.driftOrInvariant,
    );
  }
  const changes: GeneratorChange[] = present.map((path) => ({
    path,
    action: "removed" as const,
  }));
  const agentsMd = await planRulesIndexWith(root, {
    add: [],
    remove: pack.rules,
  });
  if (agentsMd !== undefined) {
    changes.push({ path: "AGENTS.md", action: "updated" });
  }
  const lock = await planLockWith(root, {
    add: [],
    remove: pack.skills,
    removeFiles: packFileLockEntries(files).map((entry) => entry.path),
  });
  if (lock !== undefined) {
    changes.push({ path: "skills-lock.json", action: lock.action });
  }
  // copy mode: the fingerprints of the manifest prove which .claude copies
  // are ours — delete them and drop their entries in the same write
  const hashes = { ...manifest.projections.hashes };
  const copiesToDelete: string[] = [];
  if (manifest.projections.mode === "copy") {
    const prefixes = [
      ...pack.skills.map((skill) => `.claude/skills/${skill}/`),
      ...pack.rules.map((rule) => `.claude/rules/${rule}`),
    ];
    for (const key of Object.keys(hashes)) {
      if (prefixes.some((prefix) => key === prefix || key.startsWith(prefix))) {
        delete hashes[key];
        copiesToDelete.push(key);
        changes.push({ path: key, action: "removed" });
      }
    }
  }
  const nextManifest: Manifest = {
    ...manifest,
    packs: {
      installed: manifest.packs.installed.filter((entry) => entry !== name),
    },
    projections: { mode: manifest.projections.mode, hashes },
  };
  if (
    name === "worktrees" &&
    nextManifest.worktrees !== undefined &&
    nextManifest.worktrees.setup.length === 0 &&
    nextManifest.worktrees.cleanup.length === 0
  ) {
    // drop the seeded-but-unused section; user-declared commands are kept
    delete nextManifest.worktrees;
  }
  changes.push({ path: MANIFEST_FILE, action: "updated" });
  if (!options.dryRun) {
    for (const skill of pack.skills) {
      await rm(join(root, ".agents", "skills", skill), {
        recursive: true,
        force: true,
      });
    }
    for (const [path] of expected) {
      if (path.startsWith(".agents/skills/")) {
        continue; // removed with the folder
      }
      await rm(resolveInsideRepo(root, path), { force: true });
    }
    for (const key of copiesToDelete) {
      // keys come from the manifest of a possibly cloned repo: confine them
      await rm(resolveInsideRepo(root, key), { force: true });
    }
    for (const skill of pack.skills) {
      await removeIfNoFilesLeft(join(root, ".claude", "skills", skill));
    }
    if (agentsMd !== undefined) {
      await writeFile(join(root, "AGENTS.md"), agentsMd, "utf8");
    }
    if (lock !== undefined) {
      if (lock.content === undefined) {
        await rm(join(root, "skills-lock.json"), { force: true });
      } else {
        await writeFile(join(root, "skills-lock.json"), lock.content, "utf8");
      }
    }
    await writeFile(
      join(root, MANIFEST_FILE),
      renderManifest(nextManifest),
      "utf8",
    );
  }
  return {
    changes: sortChanges([
      ...changes,
      // removing a pack strands the projections of the files it took away
      ...(await resyncProjections(root, nextManifest, {
        dryRun: options.dryRun,
      })),
    ]),
    notes: [],
    exitCode: EXIT_CODES.ok,
    mode: manifest.projections.mode,
  };
}

export const packAddCommand = defineCommand({
  meta: {
    name: "add",
    description: `Install a content pack (${INSTALLABLE_PACKS.join(", ")})`,
  },
  args: {
    name: {
      type: "positional",
      description: "Pack name",
      required: true,
    },
    "dry-run": {
      type: "boolean",
      description: "Print the write plan without touching the disk",
    },
    json: {
      type: "boolean",
      description: "Machine output: a single JSON object on stdout",
    },
  },
  async run({ args }) {
    const dryRun = args["dry-run"] === true;
    await runGeneratorCli("pack add", args.json === true, async () => {
      const root = await resolveRepoRoot(process.cwd());
      const result = await runPackAdd(root, String(args.name), { dryRun });
      for (const note of result.notes) {
        console.error(note);
      }
      return { result, report: renderGeneratorReport(result, { dryRun }) };
    });
  },
});

export const packRemoveCommand = defineCommand({
  meta: {
    name: "remove",
    description:
      "Remove an installed content pack (refuses locally modified files without --force)",
  },
  args: {
    name: {
      type: "positional",
      description: "Pack name",
      required: true,
    },
    force: {
      type: "boolean",
      description: "Remove the pack even when its files were modified locally",
    },
    "dry-run": {
      type: "boolean",
      description: "Print the removal plan without touching the disk",
    },
    json: {
      type: "boolean",
      description: "Machine output: a single JSON object on stdout",
    },
  },
  async run({ args }) {
    const dryRun = args["dry-run"] === true;
    await runGeneratorCli("pack remove", args.json === true, async () => {
      const root = await resolveRepoRoot(process.cwd());
      const result = await runPackRemove(root, String(args.name), {
        force: args.force === true,
        dryRun,
      });
      for (const note of result.notes) {
        console.error(note);
      }
      return { result, report: renderGeneratorReport(result, { dryRun }) };
    });
  },
});

/**
 * Regenerated rules-index block of AGENTS.md: disk rules, plus the pack rules
 * being added, minus the ones being removed. Returns the next AGENTS.md, or
 * undefined when the block is already in step.
 */
async function planRulesIndexWith(
  root: string,
  delta: {
    add: { file: string; content: string }[];
    remove: string[];
  },
): Promise<string | undefined> {
  return (await planRulesIndex(root, delta))?.next;
}

/**
 * skills-lock.json with agentsdir entries added or removed. Returns undefined
 * when nothing changes; `content` undefined means "delete the emptied file".
 */
async function planLockWith(
  root: string,
  delta: {
    add: { skill: string; hash: string }[];
    remove: string[];
    /** Rules and shared scripts the install writes outside any skill folder. */
    addFiles?: { path: string; hash: string }[];
    removeFiles?: string[];
  },
): Promise<
  { action: "created" | "updated" | "removed"; content?: string } | undefined
> {
  const addFiles = delta.addFiles ?? [];
  const removeFiles = delta.removeFiles ?? [];
  if (
    delta.add.length === 0 &&
    delta.remove.length === 0 &&
    addFiles.length === 0 &&
    removeFiles.length === 0
  ) {
    return undefined;
  }
  let raw: string | undefined;
  try {
    raw = await readFile(join(root, "skills-lock.json"), "utf8");
  } catch {
    raw = undefined;
  }
  if (raw === undefined && delta.add.length === 0 && addFiles.length === 0) {
    return undefined;
  }
  let data: Record<string, unknown>;
  if (raw === undefined) {
    data = { version: 1, skills: {} };
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CliError(
        "skills-lock.json is not valid JSON — restore it from git history.",
        EXIT_CODES.driftOrInvariant,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new CliError(
        "skills-lock.json must contain a JSON object — restore it from git history.",
        EXIT_CODES.driftOrInvariant,
      );
    }
    data = parsed as Record<string, unknown>;
  }
  const skillsRaw = data["skills"];
  const skills =
    typeof skillsRaw === "object" &&
    skillsRaw !== null &&
    !Array.isArray(skillsRaw)
      ? (skillsRaw as Record<string, unknown>)
      : {};
  data["skills"] = skills;
  for (const entry of delta.add) {
    skills[entry.skill] = agentsdirLockEntry(entry.skill, entry.hash);
  }
  for (const skill of delta.remove) {
    delete skills[skill];
  }
  const filesRaw = data["files"];
  const files =
    typeof filesRaw === "object" &&
    filesRaw !== null &&
    !Array.isArray(filesRaw)
      ? (filesRaw as Record<string, unknown>)
      : {};
  for (const entry of addFiles) {
    files[entry.path] = agentsdirFileLockEntry(entry.hash);
  }
  for (const path of removeFiles) {
    delete files[path];
  }
  // an empty `files` table is dropped rather than written as `{}`: the absent
  // table is the documented "nothing tracked outside the skills"
  if (Object.keys(files).length === 0) {
    delete data["files"];
  } else {
    data["files"] = sortedByKey(files);
  }
  if (Object.keys(skills).length === 0 && data["files"] === undefined) {
    return raw === undefined ? undefined : { action: "removed" };
  }
  const rendered = `${JSON.stringify(data, null, 2)}\n`;
  if (rendered === raw) {
    return undefined;
  }
  return {
    action: raw === undefined ? "created" : "updated",
    content: rendered,
  };
}

/** Deterministic key order: the lock is a versioned file, diffed by humans. */
function sortedByKey(table: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(table).sort()) {
    sorted[key] = table[key];
  }
  return sorted;
}

function contentOf(files: PackFile[], path: string): string {
  return files.find((file) => file.path === path)?.content ?? "";
}

function sortChanges(changes: GeneratorChange[]): GeneratorChange[] {
  return [...changes].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

async function walkFiles(absDir: string): Promise<string[]> {
  // this feeds the guard that spots locally modified pack files before a
  // removal: reading an unreadable directory as empty would make `pack remove`
  // delete without asking for --force
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new CliError(
      `Cannot read ${absDir} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions or restore it — refusing to remove files it cannot inspect.`,
      EXIT_CODES.environmentOrUsage,
    );
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const rel of await walkFiles(join(absDir, entry.name))) {
        files.push(`${entry.name}/${rel}`);
      }
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files;
}

/** Deletes the folder when only empty directories remain (our copies are gone). */
async function removeIfNoFilesLeft(dir: string): Promise<void> {
  try {
    if ((await walkFiles(dir)).length === 0) {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    // absent or not a directory: nothing to clean
  }
}
