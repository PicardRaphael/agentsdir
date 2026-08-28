import { describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import { parseSkillMarkdown } from "../frontmatter.js";

function skillMarkdown(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    name: "mon-skill",
    description:
      ">-\n  Fait X de bout en bout. Use when the user asks to X, Y or Z.",
    "display-name": '"Mon Skill"',
    "short-description": '"Fait X de bout en bout, en autonomie"',
    color: '"#1F4E8C"',
    icon: "badge-check",
    "default-prompt": '"Use $mon-skill to do X end to end."',
    implicit: "false",
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n# Mon skill\n\nBody content.\n`;
}

function parseError(source: string): CliError {
  try {
    parseSkillMarkdown(source);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    return error as CliError;
  }
  throw new Error("expected parseSkillMarkdown to throw");
}

describe("06 - skill frontmatter", () => {
  it("Given the documented extended frontmatter, When parsed, Then every field lands typed and the body is returned", () => {
    const { frontmatter, body } = parseSkillMarkdown(skillMarkdown());
    expect(frontmatter).toEqual({
      name: "mon-skill",
      description:
        "Fait X de bout en bout. Use when the user asks to X, Y or Z.",
      displayName: "Mon Skill",
      shortDescription: "Fait X de bout en bout, en autonomie",
      color: "#1F4E8C",
      icon: "badge-check",
      defaultPrompt: "Use $mon-skill to do X end to end.",
      implicit: false,
      disableModelInvocation: undefined,
      argumentHint: undefined,
      allowedTools: undefined,
    });
    expect(body).toContain("# Mon skill");
  });

  it("Given a missing required field, When parsed, Then it fails with exit code 1 naming the field", () => {
    const error = parseError(skillMarkdown({ "short-description": "" }));
    expect(error.message).toContain("`short-description`");
  });

  it("Given an invalid color, When parsed, Then it fails naming the expected #RRGGBB format", () => {
    const error = parseError(skillMarkdown({ color: '"blue"' }));
    expect(error.message).toContain("#RRGGBB");
  });

  it("Given a short-description outside 25 to 64 characters, When parsed, Then it fails with the measured length in code points", () => {
    const tooShort = parseError(
      skillMarkdown({ "short-description": `"${"a".repeat(23)}🚀"` }),
    );
    expect(tooShort.message).toContain("got 24");
    const emojiCounted = parseSkillMarkdown(
      skillMarkdown({ "short-description": `"${"a".repeat(24)}🚀"` }),
    );
    expect([...emojiCounted.frontmatter.shortDescription].length).toBe(25);
  });

  it("Given a default-prompt without the exact $<name> token, When parsed, Then it fails — a longer name does not satisfy the boundary", () => {
    const missing = parseError(
      skillMarkdown({ "default-prompt": '"Use this skill to do X."' }),
    );
    expect(missing.message).toContain("$mon-skill");
    const wrongBoundary = parseError(
      skillMarkdown({ "default-prompt": '"Use $mon-skill-extended to do X."' }),
    );
    expect(wrongBoundary.message).toContain("$mon-skill");
  });

  it("Given a file without a frontmatter block, When parsed, Then it fails with an actionable message", () => {
    const error = parseError("# Just a title\n\nNo frontmatter here.\n");
    expect(error.message).toContain("frontmatter");
  });

  it("Given invalid YAML in the frontmatter, When parsed, Then it fails mentioning YAML", () => {
    const error = parseError("---\nname: [unclosed\n---\n\nBody.\n");
    expect(error.message).toContain("YAML");
  });

  it("Given implicit omitted, When parsed, Then it defaults to false", () => {
    const { frontmatter } = parseSkillMarkdown(skillMarkdown({ implicit: "" }));
    expect(frontmatter.implicit).toBe(false);
  });
});
