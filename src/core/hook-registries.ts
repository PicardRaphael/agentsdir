import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXIT_CODES } from "../exit-codes.js";
import { CliError } from "./errors.js";

/**
 * Exact registration matrix of the three harnesses — the part most likely to
 * break between harness versions (Cursor already broke it once).
 *
 * Source: docs/harness.md §3. Last validated: 2026-08-29, against the three
 * official documentations:
 * - Claude Code — code.claude.com/docs/en/hooks: `hooks` envelope in
 *   `.claude/settings.json`, matcher groups
 *   `{matcher?, hooks: [{type: "command", command}]}` per event.
 * - Codex — developers.openai.com/codex/hooks: `.codex/hooks.json` with the
 *   same `hooks` envelope and the same matcher-group shape as Claude
 *   (earlier repo docs said "events at the file root, no envelope" — wrong,
 *   fixed on validation; third-party guides still disagree, the official doc
 *   prevails).
 * - Cursor — cursor.com/docs/hooks: `.cursor/hooks.json` with a required
 *   `version: 1`, a `hooks` envelope, lowerCamelCase event keys — some
 *   renamed (`UserPromptSubmit` → `beforeSubmitPrompt`) — and flat entries
 *   `{command, matcher?, ...}`. The matcher exists there but uses Cursor's
 *   own tool vocabulary (`Shell`, not `Bash`), so a Claude-style matcher is
 *   never projected to Cursor.
 */
export interface HookEventSpec {
  /** Canonical event name (Claude Code / Codex casing). */
  name: string;
  claude: boolean;
  codex: boolean;
  /** Cursor event key (lowerCamelCase, sometimes renamed); undefined = unsupported. */
  cursor: string | undefined;
}

export const HOOK_EVENTS: readonly HookEventSpec[] = [
  { name: "PreToolUse", claude: true, codex: true, cursor: "preToolUse" },
  { name: "PostToolUse", claude: true, codex: true, cursor: "postToolUse" },
  {
    name: "UserPromptSubmit",
    claude: true,
    codex: true,
    cursor: "beforeSubmitPrompt",
  },
  { name: "Stop", claude: true, codex: true, cursor: "stop" },
  { name: "SessionStart", claude: true, codex: true, cursor: "sessionStart" },
  { name: "SessionEnd", claude: true, codex: true, cursor: "sessionEnd" },
  { name: "SubagentStart", claude: true, codex: true, cursor: "subagentStart" },
  { name: "SubagentStop", claude: true, codex: true, cursor: "subagentStop" },
  { name: "PreCompact", claude: true, codex: true, cursor: "preCompact" },
  { name: "PostCompact", claude: true, codex: true, cursor: undefined },
  {
    name: "PermissionRequest",
    claude: true,
    codex: true,
    cursor: undefined,
  },
  { name: "Notification", claude: true, codex: false, cursor: undefined },
];

export const HOOK_HARNESSES = ["claude", "codex", "cursor"] as const;
export type HookHarness = (typeof HOOK_HARNESSES)[number];

export const HOOK_REGISTRY_PATHS: Record<HookHarness, string> = {
  claude: ".claude/settings.json",
  codex: ".codex/hooks.json",
  cursor: ".cursor/hooks.json",
};

export const HOOKS_DIR = ".agents/hooks";

/** Case-insensitive lookup of a canonical event. */
export function resolveHookEvent(input: string): HookEventSpec | undefined {
  const lowered = input.toLowerCase();
  return HOOK_EVENTS.find((event) => event.name.toLowerCase() === lowered);
}

export function supportedHarnesses(event: HookEventSpec): HookHarness[] {
  return HOOK_HARNESSES.filter((harness) => supports(harness, event));
}

function supports(harness: HookHarness, event: HookEventSpec): boolean {
  if (harness === "claude") {
    return event.claude;
  }
  if (harness === "codex") {
    return event.codex;
  }
  return event.cursor !== undefined;
}

/**
 * Metadata comment carried by every generated script. `sync` re-reads it to
 * regenerate the registrations, so the matcher lives in the script itself.
 */
export function hookMetadataLine(
  eventName: string,
  matcher: string | undefined,
): string {
  const meta: Record<string, string> = { event: eventName };
  if (matcher !== undefined) {
    meta["matcher"] = matcher;
  }
  return `// agentsdir:hook ${JSON.stringify(meta)}`;
}

// multiline: a shebang or a prepended comment must not hide the metadata
const META_PATTERN = /^\/\/ agentsdir:hook (\{.*\})\s*$/m;

export interface HookRegistration {
  /** Script file name inside `.agents/hooks/`. */
  file: string;
  event: HookEventSpec;
  matcher: string | undefined;
}

export function parseHookMetadata(
  source: string,
): { event: HookEventSpec; matcher: string | undefined } | undefined {
  const match = source.match(META_PATTERN);
  if (match === null) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const table = data as Record<string, unknown>;
  if (typeof table["event"] !== "string") {
    return undefined;
  }
  const event = resolveHookEvent(table["event"]);
  if (event === undefined) {
    return undefined;
  }
  const matcher = table["matcher"];
  return { event, matcher: typeof matcher === "string" ? matcher : undefined };
}

export interface HookRegistryPlan {
  /** Repo-relative path, always with forward slashes. */
  path: string;
  action: "created" | "updated" | "ok";
  /** Bytes to write; absent when the file is already in step. */
  content?: string;
}

/**
 * Computes the registration files of every enabled harness from the scripts
 * in `.agents/hooks/` — shared by `add hook` and `sync`, so a deleted script
 * loses its registrations on the next `sync` (clean deregistration).
 *
 * Merge rules (structural — JSON has no comment markers, so there is no
 * managed block; ownership is recognized by the command):
 * - an entry belongs to agentsdir iff its command is exactly
 *   `node .agents/hooks/<file>` — user entries are never touched;
 * - agentsdir entries are removed when their script is gone (orphan) and
 *   regenerated from the script metadata otherwise;
 * - an expected entry is NOT added when any existing entry of the event
 *   already references the script (a user may have merged our command into
 *   their own group) — no duplicate execution;
 * - a registry file is never created when there is nothing to register in it,
 *   and an existing file whose parsed structure does not change is left
 *   byte-for-byte intact (user formatting preserved).
 *
 * The optional overlay (repo-relative POSIX paths → content) stands in for
 * scripts about to be written, so `--dry-run` computes the real plan.
 */
export async function planHookRegistrations(
  root: string,
  enabledHarnesses: string[],
  overlay: Record<string, string> = {},
): Promise<HookRegistryPlan[]> {
  const scripts = await listHookScripts(root, overlay);
  const scriptFiles = new Set(scripts.map((script) => script.file));
  const registrations: HookRegistration[] = [];
  for (const script of scripts) {
    const attributed = attributeScript(script.file, script.source);
    if (attributed !== undefined) {
      registrations.push(attributed);
    }
  }
  const attributable = new Set(registrations.map((entry) => entry.file));
  const plans: HookRegistryPlan[] = [];
  for (const harness of HOOK_HARNESSES) {
    if (!enabledHarnesses.includes(harness)) {
      continue;
    }
    const path = HOOK_REGISTRY_PATHS[harness];
    const expectedHere = registrations.filter((entry) =>
      supports(harness, entry.event),
    );
    let raw: string | undefined;
    try {
      raw = await readFile(join(root, ...path.split("/")), "utf8");
    } catch {
      raw = undefined;
    }
    if (raw === undefined && expectedHere.length === 0) {
      continue;
    }
    const parsed = raw === undefined ? undefined : parseRegistry(raw, path);
    const before = parsed === undefined ? undefined : JSON.stringify(parsed);
    const next = mergeRegistry(
      harness,
      parsed,
      expectedHere,
      scriptFiles,
      attributable,
    );
    if (before !== undefined && JSON.stringify(next) === before) {
      plans.push({ path, action: "ok" });
      continue;
    }
    plans.push({
      path,
      action: raw === undefined ? "created" : "updated",
      content: `${JSON.stringify(next, null, 2)}\n`,
    });
  }
  return plans;
}

interface HookScriptSource {
  file: string;
  source: string;
}

async function listHookScripts(
  root: string,
  overlay: Record<string, string>,
): Promise<HookScriptSource[]> {
  const sources = new Map<string, string>();
  try {
    const entries = await readdir(join(root, ".agents", "hooks"), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".mjs")) {
        sources.set(
          entry.name,
          await readFile(join(root, ".agents", "hooks", entry.name), "utf8"),
        );
      }
    }
  } catch {
    // no hooks directory yet
  }
  for (const [key, content] of Object.entries(overlay)) {
    if (key.startsWith(`${HOOKS_DIR}/`) && key.endsWith(".mjs")) {
      sources.set(key.slice(HOOKS_DIR.length + 1), content);
    }
  }
  return [...sources.keys()]
    .sort()
    .map((file) => ({ file, source: sources.get(file) ?? "" }));
}

/**
 * {event, matcher} of a script: its metadata comment, or the `<event>-<slug>`
 * file name convention as fallback. A script naming no known event is
 * user-managed — never registered, never deregistered.
 */
function attributeScript(
  file: string,
  source: string,
): HookRegistration | undefined {
  const meta = parseHookMetadata(source);
  if (meta !== undefined) {
    return { file, event: meta.event, matcher: meta.matcher };
  }
  const prefix = file.replace(/\.mjs$/, "").split("-")[0] ?? "";
  const event = resolveHookEvent(prefix);
  return event === undefined ? undefined : { file, event, matcher: undefined };
}

function parseRegistry(raw: string, path: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CliError(
      `${path} is not valid JSON — fix it by hand before agentsdir can merge hook registrations into it.`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CliError(
      `${path} must contain a JSON object at the top level — fix it by hand.`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  return data as Record<string, unknown>;
}

/**
 * The three registries share the layout `{..., hooks: {<event>: [...]}}`;
 * Cursor adds a mandatory `version: 1` and flat entries, Claude and Codex use
 * matcher groups.
 */
function mergeRegistry(
  harness: HookHarness,
  current: Record<string, unknown> | undefined,
  expectedHere: HookRegistration[],
  scriptFiles: Set<string>,
  attributable: Set<string>,
): Record<string, unknown> {
  const root = current ?? (harness === "cursor" ? { version: 1 } : {});
  if (harness === "cursor" && root["version"] !== 1) {
    throw new CliError(
      `.cursor/hooks.json declares version ${JSON.stringify(root["version"])} — this CLI only knows version 1 and refuses to write blind. Upgrade agentsdir or fix the file.`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  const existing = root["hooks"];
  if (
    existing !== undefined &&
    (typeof existing !== "object" ||
      existing === null ||
      Array.isArray(existing))
  ) {
    throw new CliError(
      `${HOOK_REGISTRY_PATHS[harness]} has a \`hooks\` key that is not an object — fix it by hand.`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  const container = (existing ?? {}) as Record<string, unknown>;
  if (harness === "cursor") {
    mergeFlatEvents(container, expectedHere, scriptFiles, attributable);
  } else {
    mergeGroupedEvents(
      container,
      harness,
      expectedHere,
      scriptFiles,
      attributable,
    );
  }
  if (existing === undefined && Object.keys(container).length > 0) {
    root["hooks"] = container;
  }
  return root;
}

/** Claude and Codex share the matcher-group entry shape and canonical keys. */
function mergeGroupedEvents(
  container: Record<string, unknown>,
  harness: HookHarness,
  expectedHere: HookRegistration[],
  scriptFiles: Set<string>,
  attributable: Set<string>,
): void {
  for (const spec of HOOK_EVENTS) {
    if (!supports(harness, spec)) {
      continue;
    }
    removeManagedEntries(
      container,
      spec.name,
      scriptFiles,
      attributable,
      ownedGroupFile,
    );
  }
  for (const registration of expectedHere) {
    insertEntry(
      container,
      registration.event.name,
      registration,
      (entry) => groupReferencesFile(entry, registration.file),
      makeGroup,
    );
  }
}

function mergeFlatEvents(
  container: Record<string, unknown>,
  expectedHere: HookRegistration[],
  scriptFiles: Set<string>,
  attributable: Set<string>,
): void {
  for (const spec of HOOK_EVENTS) {
    if (spec.cursor === undefined) {
      continue;
    }
    removeManagedEntries(
      container,
      spec.cursor,
      scriptFiles,
      attributable,
      ownedFlatFile,
    );
  }
  for (const registration of expectedHere) {
    const key = registration.event.cursor;
    if (key === undefined) {
      continue;
    }
    insertEntry(
      container,
      key,
      registration,
      (entry) => flatReferencesFile(entry, registration.file),
      makeFlat,
    );
  }
}

/**
 * Drops agentsdir entries whose script is gone (orphans) or about to be
 * regenerated; user entries are kept untouched. An emptied event key is
 * removed; one that was already empty is left alone.
 */
function removeManagedEntries(
  container: Record<string, unknown>,
  key: string,
  scriptFiles: Set<string>,
  attributable: Set<string>,
  ownedFileOf: (entry: unknown) => string | undefined,
): void {
  const value = container[key];
  if (!Array.isArray(value)) {
    return;
  }
  const kept = value.filter((entry) => {
    const file = ownedFileOf(entry);
    if (file === undefined) {
      return true;
    }
    return scriptFiles.has(file) && !attributable.has(file);
  });
  if (kept.length === value.length) {
    return;
  }
  if (kept.length === 0) {
    delete container[key];
  } else {
    container[key] = kept;
  }
}

/** Appends the expected entry unless the event already references the script. */
function insertEntry(
  container: Record<string, unknown>,
  key: string,
  registration: HookRegistration,
  references: (entry: unknown) => boolean,
  make: (registration: HookRegistration) => unknown,
): void {
  const value = container[key];
  const entries = Array.isArray(value) ? value : [];
  if (entries.some(references)) {
    return;
  }
  entries.push(make(registration));
  container[key] = entries;
}

const OWNED_COMMAND = /^node \.agents\/hooks\/([A-Za-z0-9._-]+\.mjs)$/;

function ownedCommandFile(command: unknown): string | undefined {
  if (typeof command !== "string") {
    return undefined;
  }
  return command.match(OWNED_COMMAND)?.[1];
}

/** A group is agentsdir's iff it holds exactly one command handler pointing into .agents/hooks/. */
function ownedGroupFile(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const handlers = (entry as Record<string, unknown>)["hooks"];
  if (!Array.isArray(handlers) || handlers.length !== 1) {
    return undefined;
  }
  const handler = handlers[0];
  if (typeof handler !== "object" || handler === null) {
    return undefined;
  }
  const table = handler as Record<string, unknown>;
  if (table["type"] !== "command") {
    return undefined;
  }
  return ownedCommandFile(table["command"]);
}

function ownedFlatFile(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  return ownedCommandFile((entry as Record<string, unknown>)["command"]);
}

function groupReferencesFile(entry: unknown, file: string): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const handlers = (entry as Record<string, unknown>)["hooks"];
  if (!Array.isArray(handlers)) {
    return false;
  }
  return handlers.some((handler) => {
    if (typeof handler !== "object" || handler === null) {
      return false;
    }
    const command = (handler as Record<string, unknown>)["command"];
    return (
      typeof command === "string" && command.includes(`.agents/hooks/${file}`)
    );
  });
}

function flatReferencesFile(entry: unknown, file: string): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const command = (entry as Record<string, unknown>)["command"];
  return (
    typeof command === "string" && command.includes(`.agents/hooks/${file}`)
  );
}

function makeGroup(registration: HookRegistration): unknown {
  const group: Record<string, unknown> = {};
  if (registration.matcher !== undefined) {
    group["matcher"] = registration.matcher;
  }
  group["hooks"] = [
    {
      type: "command",
      command: `node .agents/hooks/${registration.file}`,
    },
  ];
  return group;
}

/** Cursor entry: flat, and never a matcher — Cursor's matcher vocabulary differs. */
function makeFlat(registration: HookRegistration): unknown {
  return { command: `node .agents/hooks/${registration.file}` };
}
