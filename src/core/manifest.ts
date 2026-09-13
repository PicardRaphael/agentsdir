import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify, TomlError } from "smol-toml";
import { CliError } from "./errors.js";

export const MANIFEST_FILE = ".agents.toml";
export const MANIFEST_SCHEMA = 2;

const MANIFEST_HEADER =
  "# .agents.toml — agentsdir manifest. Managed by the CLI; do not edit by hand.";

export type ProjectionMode = "symlink" | "copy";

/** Parses a user-supplied `--mode` value; shared by `init` and `sync`. */
export function parseMode(raw: string): ProjectionMode {
  if (raw === "symlink" || raw === "copy") {
    return raw;
  }
  throw new CliError('Unknown value for --mode (allowed: "symlink", "copy").');
}

export interface Manifest {
  schema: number;
  cliVersion: string;
  project: { name: string; stack: string[] };
  harness: { enabled: string[] };
  packs: { installed: string[] };
  /**
   * Extension points of the worktrees pack: stack-specific commands run by
   * worktree-setup/-cleanup. Optional — seeded empty by `pack add worktrees`.
   */
  worktrees?: { setup: string[]; cleanup: string[] };
  /**
   * Extension points of the usage pack: the collection switch and the paths
   * kept out of the journal. Optional — seeded by `pack add usage`, and read
   * by the hook scripts themselves, which is why both values stay on one line
   * each (the scripts carry a minimal reader, not a TOML parser).
   */
  usage?: { enabled: boolean; exclude: string[] };
  projections: { mode: ProjectionMode; hashes: Record<string, string> };
}

/** User-facing manifest failure; carries the environment/usage exit code. */
export class ManifestError extends CliError {}

/**
 * Reads and validates `dir`/.agents.toml. Throws a ManifestError with an
 * actionable message when the file is missing, is not valid TOML, or declares
 * a schema this CLI does not know.
 */
export async function readManifest(dir: string): Promise<Manifest> {
  const path = join(dir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ManifestError(
        `Manifest ${MANIFEST_FILE} not found in ${dir}. Run \`agentsdir init\` to create it.`,
      );
    }
    // it is there and cannot be read: saying "not found" would send the user
    // to `init`, which would refuse on a repository that is already
    // initialized. And `doctor` promises a diagnosis, never a failure — it can
    // only keep that promise if the fault reaches it as a ManifestError.
    throw new ManifestError(
      `Manifest ${MANIFEST_FILE} cannot be read in ${dir} (${code ?? "unknown error"}). Fix its permissions or restore it — it is there, it is just unreadable.`,
    );
  }
  let data: unknown;
  try {
    data = parse(raw);
  } catch (error) {
    const detail = error instanceof TomlError ? error.message : String(error);
    throw new ManifestError(
      `Manifest ${MANIFEST_FILE} is not valid TOML. Restore it from git history or re-run \`agentsdir init\`.\n${detail}`,
    );
  }
  return validateManifest(data);
}

/** Writes the manifest; the output is deterministic byte for byte for a given state. */
export async function writeManifest(
  dir: string,
  manifest: Manifest,
): Promise<void> {
  await writeFile(join(dir, MANIFEST_FILE), renderManifest(manifest), "utf8");
}

/**
 * Renders the manifest to TOML. Hash keys are sorted by code unit (never by
 * locale) and the empty hashes table is omitted, so the same state always
 * produces the same bytes — the fingerprints in `check` depend on it.
 */
export function renderManifest(manifest: Manifest): string {
  const hashEntries = Object.entries(manifest.projections.hashes).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const projections: Record<string, unknown> = {
    mode: manifest.projections.mode,
  };
  if (hashEntries.length > 0) {
    projections["hashes"] = Object.fromEntries(hashEntries);
  }
  const body = stringify({
    schema: manifest.schema,
    "cli-version": manifest.cliVersion,
    project: { name: manifest.project.name, stack: manifest.project.stack },
    harness: { enabled: manifest.harness.enabled },
    packs: { installed: manifest.packs.installed },
    ...(manifest.worktrees !== undefined
      ? {
          worktrees: {
            setup: manifest.worktrees.setup,
            cleanup: manifest.worktrees.cleanup,
          },
        }
      : {}),
    ...(manifest.usage !== undefined
      ? {
          usage: {
            enabled: manifest.usage.enabled,
            exclude: manifest.usage.exclude,
          },
        }
      : {}),
    projections,
  });
  return `${MANIFEST_HEADER}\n\n${body}`;
}

function validateManifest(data: unknown): Manifest {
  const root = asTable(data, "manifest root");
  const schema = root["schema"];
  if (typeof schema !== "number" || !Number.isInteger(schema)) {
    throw new ManifestError(
      `Manifest field \`schema\` must be an integer. Restore ${MANIFEST_FILE} from git history or re-run \`agentsdir init\`.`,
    );
  }
  if (schema > MANIFEST_SCHEMA) {
    throw new ManifestError(
      `Manifest schema ${schema} is newer than this CLI supports (${MANIFEST_SCHEMA}). Upgrade with \`npx agentsdir@latest\`.`,
    );
  }
  if (schema < 1) {
    throw new ManifestError(
      `Manifest schema ${schema} is unknown (the first schema is 1). Restore ${MANIFEST_FILE} from git history or re-run \`agentsdir init\`.`,
    );
  }
  const project = asTable(root["project"], "[project]");
  const harness = asTable(root["harness"], "[harness]");
  const packs = asTable(root["packs"], "[packs]");
  const projections = asTable(root["projections"], "[projections]");
  let worktrees: { setup: string[]; cleanup: string[] } | undefined;
  if (root["worktrees"] !== undefined) {
    const table = asTable(root["worktrees"], "[worktrees]");
    worktrees = {
      setup: optionalStringArray(table, "setup", "`[worktrees].setup`"),
      cleanup: optionalStringArray(table, "cleanup", "`[worktrees].cleanup`"),
    };
  }
  let usage: { enabled: boolean; exclude: string[] } | undefined;
  if (root["usage"] !== undefined) {
    const table = asTable(root["usage"], "[usage]");
    const enabled = table["enabled"];
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new ManifestError(
        "Manifest field `[usage].enabled` must be true or false.",
      );
    }
    usage = {
      // absent means on: a repo that installed the pack asked for collection,
      // and only an explicit `false` suspends it
      enabled: enabled ?? true,
      exclude: optionalStringArray(table, "exclude", "`[usage].exclude`"),
    };
  }
  const mode = projections["mode"];
  if (mode !== "symlink" && mode !== "copy") {
    throw new ManifestError(
      'Manifest field `[projections].mode` must be "symlink" or "copy".',
    );
  }
  return {
    schema,
    cliVersion: requireString(root, "cli-version", "`cli-version`"),
    project: {
      name: requireString(project, "name", "`[project].name`"),
      stack: requireStringArray(project, "stack", "`[project].stack`"),
    },
    harness: {
      enabled: requireStringArray(harness, "enabled", "`[harness].enabled`"),
    },
    packs: {
      installed: requireStringArray(packs, "installed", "`[packs].installed`"),
    },
    ...(worktrees !== undefined ? { worktrees } : {}),
    ...(usage !== undefined ? { usage } : {}),
    projections: {
      mode,
      hashes: readHashes(projections["hashes"]),
    },
  };
}

function optionalStringArray(
  table: Record<string, unknown>,
  key: string,
  context: string,
): string[] {
  if (table[key] === undefined) {
    return [];
  }
  return requireStringArray(table, key, context);
}

function readHashes(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const table = asTable(value, "[projections.hashes]");
  const hashes: Record<string, string> = {};
  for (const [key, entry] of Object.entries(table)) {
    if (typeof entry !== "string") {
      throw new ManifestError(
        `Manifest field \`[projections.hashes]."${key}"\` must be a string fingerprint.`,
      );
    }
    hashes[key] = entry;
  }
  return hashes;
}

function asTable(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestError(`Manifest section ${context} must be a table.`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  table: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = table[key];
  if (typeof value !== "string") {
    throw new ManifestError(`Manifest field ${context} must be a string.`);
  }
  return value;
}

function requireStringArray(
  table: Record<string, unknown>,
  key: string,
  context: string,
): string[] {
  const value = table[key];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new ManifestError(
      `Manifest field ${context} must be an array of strings.`,
    );
  }
  return value as string[];
}
