import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXIT_CODES } from "../exit-codes.js";
import { CliError } from "./errors.js";
import { HOOK_REGISTRY_PATHS } from "./hook-registries.js";

/**
 * The permission allowlist agentsdir maintains in `.claude/settings.json`.
 *
 * Why it exists: the packs install skills whose procedure tells the agent to
 * run a script — `node .agents/skills/verify/scripts/build-report.mjs …`. With
 * no matching permission rule, Claude Code asks before each run: the cascading
 * prompts `docs/architecture.md` lists among the flaws this CLI was built to
 * fix. The allowlist covers those scripts and nothing else.
 *
 * Why the merge is structural rather than a delimited block: JSON has no
 * comment markers, so there is nowhere to put `agentsdir:begin`. Ownership is
 * recognized by the shape of the rule, exactly as the hook registrations of
 * this same file already are:
 * - a rule belongs to agentsdir iff it reads `Bash(node <path under .agents/>
 *   *)` — anything else in `permissions.allow` is the user's and is never
 *   touched, moved or reordered;
 * - agentsdir rules whose script is gone are removed (orphans), and the
 *   expected ones are appended in a deterministic order;
 * - the file is never created when there is nothing to allow, and a file whose
 *   parsed content does not change is left byte-for-byte intact.
 *
 * Rule syntax: `Bash(<command> *)`. A trailing ` *` matches the command with
 * any arguments *and* the bare command, which is what these scripts need —
 * `build-report.mjs` takes two paths. The space before the `*` is part of the
 * rule (code.claude.com/docs/en/permissions).
 */
export const CLAUDE_SETTINGS_FILE = HOOK_REGISTRY_PATHS.claude;

/** Shape of a rule agentsdir owns: `node` on a script inside `.agents/`. */
const OWNED_RULE = /^Bash\(node (\.agents\/[A-Za-z0-9._/-]+\.mjs) \*\)$/;

/** The allow rule that lets an agent run one emitted script. */
export function permissionRule(scriptPath: string): string {
  return `Bash(node ${scriptPath} *)`;
}

/**
 * Next content of `.claude/settings.json` given its current content (undefined
 * when the file is absent) and the scripts to allow. Returns undefined when
 * nothing has to change — including the case of an absent file with nothing to
 * allow, where creating one would be pure noise in the user's repo.
 */
export function applyPermissions(
  current: string | undefined,
  scripts: string[],
): string | undefined {
  const expected = [...scripts].sort().map((script) => permissionRule(script));
  if (current === undefined && expected.length === 0) {
    return undefined;
  }
  const settings = current === undefined ? {} : parseSettings(current);
  const next = mergeAllow(settings, expected);
  const rendered = `${JSON.stringify(next, null, 2)}\n`;
  return rendered === current ? undefined : rendered;
}

/** Reads the file, applies the merge, and reports what a write would do. */
export async function planClaudePermissions(
  root: string,
  scripts: string[],
  options: { current?: string | undefined } = {},
): Promise<
  { action: "created" | "updated"; content: string } | { action: "ok" }
> {
  const current =
    options.current !== undefined
      ? options.current
      : await readSettings(root, CLAUDE_SETTINGS_FILE);
  const next = applyPermissions(current, scripts);
  if (next === undefined) {
    return { action: "ok" };
  }
  return {
    action: current === undefined ? "created" : "updated",
    content: next,
  };
}

/**
 * Current content of a harness registry, or undefined when it is absent. An
 * unreadable one stops the run: treating it as absent would rewrite the file
 * from scratch and drop whatever the user had configured there.
 */
export async function readSettings(
  root: string,
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(join(root, ...path.split("/")), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new CliError(
      `Cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions or restore it — refusing to overwrite a file it cannot read.`,
      EXIT_CODES.environmentOrUsage,
    );
  }
}

function parseSettings(raw: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CliError(
      `${CLAUDE_SETTINGS_FILE} is not valid JSON — fix it by hand before agentsdir can maintain its permission rules in it.`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CliError(
      `${CLAUDE_SETTINGS_FILE} must contain a JSON object at the top level — fix it by hand.`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  return data as Record<string, unknown>;
}

/**
 * Replaces the agentsdir rules of `permissions.allow`, keeping every user rule
 * where it is. An emptied `allow` is removed rather than left as `[]`, and an
 * emptied `permissions` with it — a repo that installs no script keeps a
 * settings file free of our leftovers.
 */
function mergeAllow(
  settings: Record<string, unknown>,
  expected: string[],
): Record<string, unknown> {
  const permissions = settings["permissions"];
  if (
    permissions !== undefined &&
    (typeof permissions !== "object" ||
      permissions === null ||
      Array.isArray(permissions))
  ) {
    throw new CliError(
      `${CLAUDE_SETTINGS_FILE} has a \`permissions\` key that is not an object — fix it by hand.`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  const container = (permissions ?? {}) as Record<string, unknown>;
  const allow = container["allow"];
  if (allow !== undefined && !Array.isArray(allow)) {
    throw new CliError(
      `${CLAUDE_SETTINGS_FILE} has a \`permissions.allow\` key that is not an array — fix it by hand.`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  const kept = ((allow ?? []) as unknown[]).filter(
    (rule) => typeof rule !== "string" || !OWNED_RULE.test(rule),
  );
  // a rule the user wrote themselves is left where it is; we never add a
  // second copy of it under our own name
  const missing = expected.filter((rule) => !kept.includes(rule));
  const nextAllow = [...kept, ...missing];
  if (nextAllow.length === 0) {
    delete container["allow"];
  } else {
    container["allow"] = nextAllow;
  }
  if (Object.keys(container).length === 0) {
    delete settings["permissions"];
  } else {
    settings["permissions"] = container;
  }
  return settings;
}
