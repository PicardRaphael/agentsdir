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

/** Parses and validates a SKILL.md; every violation is a CliError with exit code 1. */
export function parseSkillMarkdown(source: string): ParsedSkill {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
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
  return {
    frontmatter: validateFrontmatter(data),
    body: source.slice(match[0].length),
  };
}

function validateFrontmatter(data: unknown): SkillFrontmatter {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw invariant("SKILL.md frontmatter must be a YAML mapping of fields.");
  }
  const table = data as Record<string, unknown>;
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
  if (value.includes("\n")) {
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
