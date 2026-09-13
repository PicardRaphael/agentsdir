import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, TomlError } from "smol-toml";
import { EXIT_CODES } from "../exit-codes.js";
import { CliError } from "./errors.js";
import { HARNESS_SPECS, HARNESSES, type Harness } from "./harnesses.js";
import { upsertBlock } from "./managed-blocks.js";

/**
 * MCP servers: one declaration, three projections.
 *
 * Structurally this is the twin of the hook registries — a single source in
 * `.agents/`, several targets in heterogeneous formats, a merge that must keep
 * what the user wrote, and a drift to detect. Two things are genuinely
 * different, and both shape the code below.
 *
 * **Ownership is by name, not by content.** A hook registration is stable
 * (`node .agents/hooks/x.mjs` never changes), so "this entry equals what we
 * generate" is a sound ownership test there. A server's `args` change whenever
 * the user edits the source — and an entry that no longer matches would become
 * untouchable, leaving the stale version in the harness file for good. So a
 * name declared in the source is ours and gets rewritten; a name the manifest
 * records but the source no longer declares is ours and gets removed; every
 * other name is the user's and is never touched.
 *
 * **The source carries names of environment variables, never their values.**
 * `.agents/` is versioned, and an MCP server is usually configured with a
 * token. `env` is therefore a list of variable names and `headers` maps a
 * header to a variable name — a shape in which a secret value cannot be
 * expressed by accident. Each harness has its own way of turning a name into a
 * value at run time, and all three are used here.
 *
 * Matrix source: docs/harness.md §4. Last validated 2026-09-13 against the
 * three official documentations:
 * - Claude Code — code.claude.com/docs/en/mcp: `.mcp.json` at the repo root,
 *   `mcpServers` envelope, explicit `type` among stdio/sse/http, and `${VAR}`
 *   expansion inside `env`, `headers`, `url`, `command` and `args`.
 * - Cursor — cursor.com/docs/context/mcp: `.cursor/mcp.json`, the same
 *   `mcpServers` envelope but **no** `type` field (a remote server is one that
 *   has a `url`), and its own expansion syntax `${env:VAR}`.
 * - Codex — learn.chatgpt.com/docs/extend/mcp: `.codex/config.toml`,
 *   project-scoped for trusted projects, `[mcp_servers.<name>]` tables, and no
 *   interpolation at all: `env_vars` forwards named variables to a stdio
 *   server and `env_http_headers` maps a header to a variable name.
 */

/** The single declaration, repo-relative POSIX. */
export const MCP_SOURCE = ".agents/mcp.toml";

/** Managed block id inside `.codex/config.toml`. */
export const MCP_BLOCK = "mcp";

/** Where each harness reads its MCP servers from. */
export const MCP_PROJECTIONS: Readonly<Record<Harness, string>> = {
  claude: ".mcp.json",
  codex: `${HARNESS_SPECS.codex.dir}/config.toml`,
  cursor: `${HARNESS_SPECS.cursor.dir}/mcp.json`,
};

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServer {
  /** Key of the `[servers.<name>]` table, and the key in every projection. */
  name: string;
  transport: McpTransport;
  /** stdio only. */
  command?: string;
  args: string[];
  /** Names of environment variables forwarded to the server; never values. */
  env: string[];
  /** http/sse only. */
  url?: string;
  /** Header name to environment variable name; never a value. */
  headers: Record<string, string>;
}

/**
 * Server names follow the skill grammar: they become a JSON key, a TOML table
 * segment and, for the user, the name they type. The grammar is repeated here
 * rather than imported from `validate.ts`, which imports this module.
 */
const MCP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * What an environment variable name looks like. Anything else in an `env` entry
 * or a `headers` value is a value, which is exactly what must never reach a
 * versioned file.
 */
export const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;

const TRANSPORTS: readonly McpTransport[] = ["stdio", "http", "sse"];

/** A problem in the declaration itself, reported by `check` before any write. */
export interface McpProblem {
  /** Repo-relative path of the offending file. */
  path: string;
  rule: string;
  message: string;
}

function fail(message: string): CliError {
  return new CliError(message, EXIT_CODES.driftOrInvariant);
}

function table(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail(`${MCP_SOURCE}: ${where} must be a table.`);
  }
  return value as Record<string, unknown>;
}

function stringList(
  raw: unknown,
  where: string,
  fallback: string[] = [],
): string[] {
  if (raw === undefined) {
    return fallback;
  }
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw fail(`${MCP_SOURCE}: ${where} must be an array of strings.`);
  }
  return raw as string[];
}

/**
 * Parses the declaration. Every shape error is a refusal with the offending key
 * named: this file is written by hand, and a silent default would project a
 * server the user did not describe.
 */
export function parseMcpSource(raw: string): McpServer[] {
  let root: Record<string, unknown>;
  try {
    root = parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw fail(
      `${MCP_SOURCE} is not valid TOML (${error instanceof TomlError ? error.message : String(error)}).`,
    );
  }
  if (root["servers"] === undefined) {
    return [];
  }
  const servers = table(root["servers"], "`servers`");
  const parsed: McpServer[] = [];
  for (const name of Object.keys(servers).sort()) {
    const entry = table(servers[name], `\`servers.${name}\``);
    if (!MCP_NAME.test(name)) {
      throw fail(
        `${MCP_SOURCE}: server name "${name}" must be 1 to 64 characters of a-z, 0-9 and -, without a leading or trailing dash.`,
      );
    }
    const declared = entry["type"];
    if (typeof declared !== "string" || !isTransport(declared)) {
      throw fail(
        `${MCP_SOURCE}: \`servers.${name}.type\` must be one of ${TRANSPORTS.join(", ")}.`,
      );
    }
    const transport = declared;
    const server: McpServer = {
      name,
      transport,
      args: stringList(entry["args"], `\`servers.${name}.args\``),
      env: stringList(entry["env"], `\`servers.${name}.env\``),
      headers: headersOf(entry["headers"], name),
    };
    if (transport === "stdio") {
      const command = entry["command"];
      if (typeof command !== "string" || command.trim() === "") {
        throw fail(
          `${MCP_SOURCE}: \`servers.${name}.command\` is required for a stdio server.`,
        );
      }
      server.command = command;
    } else {
      const url = entry["url"];
      if (typeof url !== "string" || url.trim() === "") {
        throw fail(
          `${MCP_SOURCE}: \`servers.${name}.url\` is required for a ${transport} server.`,
        );
      }
      server.url = url;
    }
    parsed.push(server);
  }
  return parsed;
}

function isTransport(value: string): value is McpTransport {
  return (TRANSPORTS as readonly string[]).includes(value);
}

function headersOf(raw: unknown, name: string): Record<string, string> {
  if (raw === undefined) {
    return {};
  }
  const entries = table(raw, `\`servers.${name}.headers\``);
  const headers: Record<string, string> = {};
  for (const key of Object.keys(entries).sort()) {
    const value = entries[key];
    if (typeof value !== "string") {
      throw fail(
        `${MCP_SOURCE}: \`servers.${name}.headers.${key}\` must be the name of an environment variable.`,
      );
    }
    headers[key] = value;
  }
  return headers;
}

/**
 * Reads the declaration, or nothing when the repository has none. An absent
 * source is the normal state — most repositories declare no MCP server — and
 * must stay a non-event: no empty `.mcp.json` is created for it.
 */
export async function readMcpSource(
  root: string,
): Promise<McpServer[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(root, ...MCP_SOURCE.split("/")), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new CliError(
      `Cannot read ${MCP_SOURCE} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions or restore it — refusing to deproject servers it cannot see.`,
      EXIT_CODES.environmentOrUsage,
    );
  }
  return parseMcpSource(raw);
}

/**
 * Values where a name belongs. This is the guard the whole design exists for:
 * `.agents/mcp.toml` is committed and pushed, so a token written where a
 * variable name is expected would be published by the very command meant to
 * keep the repository tidy.
 */
export function mcpSecretProblems(servers: readonly McpServer[]): McpProblem[] {
  const problems: McpProblem[] = [];
  for (const server of servers) {
    for (const name of server.env) {
      if (!ENV_VAR_NAME.test(name)) {
        problems.push({
          path: MCP_SOURCE,
          rule: "mcp-secret-value",
          message: `\`servers.${server.name}.env\` lists "${truncate(name)}", which is not an environment variable name (A-Z, 0-9 and _). This file is versioned: list the variable name, and let the harness read its value at run time.`,
        });
      }
    }
    for (const [header, name] of Object.entries(server.headers)) {
      if (!ENV_VAR_NAME.test(name)) {
        problems.push({
          path: MCP_SOURCE,
          rule: "mcp-secret-value",
          message: `\`servers.${server.name}.headers.${header}\` is "${truncate(name)}", which is not an environment variable name (A-Z, 0-9 and _). This file is versioned: name the variable holding the secret, never the secret.`,
        });
      }
    }
  }
  return problems;
}

/** Never echo a suspected secret whole into a report a user may paste. */
function truncate(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 5)}...`;
}

export interface McpProjectionPlan {
  /** Repo-relative POSIX path of the projection. */
  path: string;
  action: "created" | "updated" | "ok";
  /** Full content to write; absent when the action is "ok". */
  content?: string;
  /** True when the write only removes servers (harness disabled, or server dropped). */
  deprojects?: boolean;
}

/**
 * The write plan for every harness, ours and only ours.
 *
 * `previous` is the set of server names the manifest records as projected. It
 * is what makes a clean removal possible: a name that left the source is still
 * recognised as ours for exactly one run, removed, and then forgotten.
 */
export async function planMcpProjections(
  root: string,
  enabledHarnesses: readonly string[],
  servers: readonly McpServer[],
  previous: readonly string[] = [],
): Promise<McpProjectionPlan[]> {
  // A projection emptied of every server keeps its file, holding `{}` or, for
  // Codex, whatever the user had around the block. That is what the hook
  // registries do with an emptied registry, and deleting a file the user can
  // see is a bigger decision than this plan is allowed to make.
  const ours = new Set([...servers.map((server) => server.name), ...previous]);
  const plans: McpProjectionPlan[] = [];
  for (const harness of HARNESSES) {
    // a disabled harness is not skipped but deprojected: skipping would leave
    // the servers of a removed harness configured and running, which is the
    // mistake the hook registries had to fix
    const enabled = enabledHarnesses.includes(harness);
    const expected = enabled ? servers : [];
    const path = MCP_PROJECTIONS[harness];
    const raw = await readProjection(root, path);
    if (raw === undefined && expected.length === 0) {
      continue;
    }
    const next =
      harness === "codex"
        ? mergeCodex(raw, expected)
        : mergeJson(harness, raw, path, expected, ours);
    if (raw !== undefined && next === raw) {
      plans.push({ path, action: "ok" });
      continue;
    }
    plans.push({
      path,
      action: raw === undefined ? "created" : "updated",
      content: next,
      ...(expected.length === 0 ? { deprojects: true } : {}),
    });
  }
  return plans;
}

async function readProjection(
  root: string,
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(join(root, ...path.split("/")), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    // an unreadable projection read as absent would be rewritten from scratch,
    // dropping every server the user declared there by hand
    throw new CliError(
      `Cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions or restore it — refusing to overwrite MCP servers it cannot read.`,
      EXIT_CODES.environmentOrUsage,
    );
  }
}

/** Claude Code and Cursor: same envelope, different dialect inside an entry. */
function mergeJson(
  harness: Harness,
  raw: string | undefined,
  path: string,
  expected: readonly McpServer[],
  ours: ReadonlySet<string>,
): string {
  let root: Record<string, unknown> = {};
  if (raw !== undefined) {
    try {
      root = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      throw fail(
        `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}) — fix it by hand; refusing to overwrite it.`,
      );
    }
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      throw fail(`${path} is not a JSON object — fix it by hand.`);
    }
  }
  const existing = root["mcpServers"];
  if (
    existing !== undefined &&
    (typeof existing !== "object" ||
      existing === null ||
      Array.isArray(existing))
  ) {
    throw fail(`${path} has an \`mcpServers\` key that is not an object.`);
  }
  const container = (existing ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(container)) {
    if (ours.has(name)) {
      delete container[name];
    }
  }
  for (const server of expected) {
    container[server.name] = jsonEntry(harness, server);
  }
  const ordered: Record<string, unknown> = {};
  for (const name of Object.keys(container).sort()) {
    ordered[name] = container[name];
  }
  if (Object.keys(ordered).length === 0) {
    delete root["mcpServers"];
  } else {
    root["mcpServers"] = ordered;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

function jsonEntry(
  harness: Harness,
  server: McpServer,
): Record<string, unknown> {
  // Cursor tells a remote server from a local one by the presence of `url` and
  // rejects nothing, but it has no `type` field: emitting one would put a key
  // in the user's file that its documentation does not describe
  const entry: Record<string, unknown> =
    harness === "claude" ? { type: server.transport } : {};
  if (server.transport === "stdio") {
    entry["command"] = server.command;
    if (server.args.length > 0) {
      entry["args"] = server.args;
    }
    if (server.env.length > 0) {
      entry["env"] = Object.fromEntries(
        server.env.map((name) => [name, reference(harness, name)]),
      );
    }
  } else {
    entry["url"] = server.url;
    const headers = Object.entries(server.headers).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (headers.length > 0) {
      entry["headers"] = Object.fromEntries(
        headers.map(([header, name]) => [header, reference(harness, name)]),
      );
    }
  }
  return entry;
}

/** How each harness spells "read this variable at run time". */
function reference(harness: Harness, name: string): string {
  return harness === "cursor" ? `\${env:${name}}` : `\${${name}}`;
}

/**
 * Codex: a managed block at the end of `.codex/config.toml`.
 *
 * The file holds the whole Codex configuration, so it is never reparsed and
 * rewritten — a round trip through a TOML serialiser would reformat what the
 * user wrote. The block is rendered whole from the source and `upsertBlock`
 * puts it back in place, leaving every other byte untouched.
 *
 * It has to be last: in TOML every key after a `[table]` header belongs to that
 * table, so a key written below the block would silently join the last server.
 * The block says so in its own first line, and `check` refuses a file where it
 * happened.
 *
 * Ownership by name plays no part here: everything between the markers is ours
 * by construction, and everything outside them is the user's.
 */
function mergeCodex(
  raw: string | undefined,
  expected: readonly McpServer[],
): string {
  const source = raw ?? "";
  if (expected.length === 0) {
    return removeBlock(source);
  }
  return upsertBlock(source, MCP_BLOCK, renderCodexBlock(expected), "hash");
}

/** The block, markers included, cut out of the file — used when nothing is projected. */
function removeBlock(source: string): string {
  const begin = `# agentsdir:begin ${MCP_BLOCK}`;
  const end = `# agentsdir:end ${MCP_BLOCK}`;
  const from = source.indexOf(begin);
  if (from === -1) {
    return source;
  }
  const to = source.indexOf(end, from);
  if (to === -1) {
    throw fail(
      `Managed block "${MCP_BLOCK}" in ${MCP_PROJECTIONS.codex} has a begin marker but no end marker. Fix or remove the broken markers, then retry.`,
    );
  }
  const cut = source.slice(0, from) + source.slice(to + end.length);
  return cut.replace(/\n{3,}$/, "\n").replace(/^\n+/, "");
}

export function renderCodexBlock(servers: readonly McpServer[]): string {
  const lines = [
    "# Keep this block last: in TOML, a key written below it would join the",
    "# table above. Declared in .agents/mcp.toml; run `agentsdir sync`.",
  ];
  for (const server of servers) {
    lines.push("", `[mcp_servers.${tomlKey(server.name)}]`);
    if (server.transport === "stdio") {
      lines.push(`command = ${tomlString(server.command ?? "")}`);
      if (server.args.length > 0) {
        lines.push(`args = ${tomlArray(server.args)}`);
      }
      if (server.env.length > 0) {
        // `env_vars` forwards named variables from the environment; `env` would
        // set literal values, which is exactly what must not be written here
        lines.push(`env_vars = ${tomlArray(server.env)}`);
      }
    } else {
      lines.push(`url = ${tomlString(server.url ?? "")}`);
      const headers = Object.entries(server.headers).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      if (headers.length > 0) {
        // header name to variable name — Codex reads the value itself, and
        // interpolation is not available in `http_headers`
        const inline = headers
          .map(
            ([header, name]) => `${tomlString(header)} = ${tomlString(name)}`,
          )
          .join(", ");
        lines.push(`env_http_headers = { ${inline} }`);
      }
    }
  }
  return lines.join("\n");
}

/** A bare key when the grammar allows it, quoted otherwise. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
}

/**
 * TOML basic strings and JSON strings agree on the escapes this CLI can emit
 * (quote, backslash, control characters), and every value here comes from a
 * hand-written declaration of commands, URLs and variable names.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}
