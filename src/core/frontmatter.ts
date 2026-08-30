import { parse } from "yaml";
import { EXIT_CODES } from "../exit-codes.js";
import { CliError } from "./errors.js";

/**
 * The extended SKILL.md frontmatter is the single catalogue: Agent Skills
 * standard fields plus the agentsdir fields that feed the Codex projections.
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  displayName: string;
  /** 25 to 64 Unicode code points, validated. */
  shortDescription: string;
  /** #RRGGBB, passed verbatim to the icon and openai.yaml. */
  color: string;
  /** Name from the embedded icon set. */
  icon: string;
  /** Must contain the exact token `$<name>`. */
  defaultPrompt: string;
  implicit: boolean;
  disableModelInvocation: boolean | undefined;
  argumentHint: string | undefined;
  allowedTools: string[] | undefined;
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  /** Markdown body after the frontmatter block. */
  body: string;
}

/**
 * The agentsdir catalogue extension fields — everything the open Agent Skills
 * spec does not define. Their presence marks a skill as agentsdir-managed.
 */
const CATALOGUE_FIELDS = [
  "display-name",
  "short-description",
  "color",
  "icon",
  "default-prompt",
] as const;

/** The two fields the open Agent Skills spec requires; nothing more. */
export interface OpenSkillFrontmatter {
  name: string;
  description: string;
}

export interface ParsedOpenSkill {
  frontmatter: OpenSkillFrontmatter;
  /** True when any agentsdir catalogue field is present in the frontmatter. */
  catalogue: boolean;
  /** Markdown body after the frontmatter block. */
  body: string;
}

/** Parses and validates a SKILL.md; every violation is a CliError with exit code 1. */
export function parseSkillMarkdown(source: string): ParsedSkill {
  const { table, body } = parseFrontmatterBlock(source);
  return {
    frontmatter: validateFrontmatter(table),
    body,
  };
}

/**
 * Parses a SKILL.md against the open Agent Skills spec only (`name` and
 * `description`). Skills installed by other tools (e.g. `npx skills`) are held
 * to this contract, never to the agentsdir catalogue.
 */
export function parseOpenSkillMarkdown(source: string): ParsedOpenSkill {
  const { table, body } = parseFrontmatterBlock(source);
  return {
    frontmatter: {
      name: requireString(table, "name"),
      description: requireString(table, "description"),
    },
    catalogue: CATALOGUE_FIELDS.some((field) => table[field] !== undefined),
    body,
  };
}

/**
 * Reads the frontmatter table of a sub-agent file (`.agents/agents/*.md`).
 * Returns undefined when the block is absent or is not valid YAML: invariant 14
 * turns that into a listed violation, because `check` must report every
 * offending file rather than throw on the first one.
 */
export function readAgentFrontmatter(
  source: string,
): Record<string, unknown> | undefined {
  const match = source.match(FRONTMATTER_BLOCK);
  if (!match) {
    return undefined;
  }
  let data: unknown;
  try {
    data = parse(match[1] ?? "");
  } catch {
    return undefined;
  }
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function parseFrontmatterBlock(source: string): {
  table: Record<string, unknown>;
  body: string;
} {
  const match = source.match(FRONTMATTER_BLOCK);
  if (!match) {
    throw invariant(
      "SKILL.md has no frontmatter block (`---` ... `---`) at the top of the file.",
    );
  }
  let data: unknown;
  try {
    data = parse(match[1] ?? "");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw invariant(`SKILL.md frontmatter is not valid YAML.\n${detail}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw invariant("SKILL.md frontmatter must be a YAML mapping of fields.");
  }
  return {
    table: data as Record<string, unknown>,
    body: source.slice(match[0].length),
  };
}

function validateFrontmatter(table: Record<string, unknown>): SkillFrontmatter {
  const name = requireString(table, "name");
  const description = requireString(table, "description");
  const displayName = requireSingleLine(table, "display-name");
  const shortDescription = requireSingleLine(table, "short-description");
  const color = requireSingleLine(table, "color");
  const icon = requireSingleLine(table, "icon");
  const defaultPrompt = requireSingleLine(table, "default-prompt");
  const shortLength = [...shortDescription].length;
  if (shortLength < 25 || shortLength > 64) {
    throw invariant(
      `Frontmatter field \`short-description\` must be 25 to 64 characters (Unicode code points); got ${shortLength}.`,
    );
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
    throw invariant(
      `Frontmatter field \`color\` must be a #RRGGBB hex color; got "${color}".`,
    );
  }
  const token = new RegExp(`\\$${escapeRegExp(name)}(?![a-z0-9-])`);
  if (!token.test(defaultPrompt)) {
    throw invariant(
      `Frontmatter field \`default-prompt\` must contain the exact token \`$${name}\`.`,
    );
  }
  return {
    name,
    description,
    displayName,
    shortDescription,
    color,
    icon,
    defaultPrompt,
    implicit: optionalBoolean(table, "implicit") ?? false,
    disableModelInvocation: optionalBoolean(table, "disable-model-invocation"),
    argumentHint: optionalString(table, "argument-hint"),
    allowedTools: optionalStringArray(table, "allowed-tools"),
  };
}

function optionalStringArray(
  table: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = table[field];
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw invariant(
      `Frontmatter field \`${field}\` must be a list of strings.`,
    );
  }
  return value as string[];
}

function requireString(table: Record<string, unknown>, field: string): string {
  const value = table[field];
  if (typeof value !== "string" || value === "") {
    throw invariant(
      `Frontmatter field \`${field}\` is missing or is not a non-empty string.`,
    );
  }
  return value;
}

function requireSingleLine(
  table: Record<string, unknown>,
  field: string,
): string {
  const value = requireString(table, field);
  // CR as well as LF: a lone \r would otherwise travel into the generated YAML
  if (/[\r\n]/.test(value)) {
    throw invariant(`Frontmatter field \`${field}\` must be a single line.`);
  }
  return value;
}

function optionalBoolean(
  table: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = table[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw invariant(`Frontmatter field \`${field}\` must be a boolean.`);
  }
  return value;
}

function optionalString(
  table: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = table[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invariant(`Frontmatter field \`${field}\` must be a string.`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function invariant(message: string): CliError {
  return new CliError(message, EXIT_CODES.driftOrInvariant);
}
