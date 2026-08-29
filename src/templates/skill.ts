/**
 * SKILL.md template of `add skill`: the complete extended frontmatter (the
 * single catalogue) plus a guided body that satisfies the depth invariant
 * (at least 12 significant lines) out of the box.
 */
export interface SkillAnswers {
  name: string;
  /** Trigger-oriented description ("Use when…"). */
  description: string;
  displayName: string;
  /** 25 to 64 Unicode code points — validated before writing. */
  shortDescription: string;
  /** #RRGGBB hex color. */
  color: string;
  /** Name from the embedded icon set. */
  icon: string;
  /** Must contain the exact token `$<name>`. */
  defaultPrompt: string;
  /** True only for a skill explicitly declared read-only. */
  implicit: boolean;
}

/** Tools an implicit skill may use — the read-only declaration, materialized. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

/** "my-skill" → "My Skill" — the default display name and rule/agent titles. */
export function displayNameFromKebab(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Valid non-TTY defaults: every field passes the `check` invariants. */
export function defaultSkillAnswers(
  name: string,
  implicit: boolean,
): SkillAnswers {
  const displayName = displayNameFromKebab(name);
  return {
    name,
    description: `Runs the ${name} workflow end to end. Use when the user asks for ${name}.`,
    displayName,
    shortDescription: clampShortDescription(
      `Runs the ${displayName} workflow end to end`,
    ),
    color: "#1F4E8C",
    icon: "terminal",
    defaultPrompt: `Use $${name} to run the workflow end to end.`,
    implicit,
  };
}

/** Keeps the default inside the validated 25-64 code point range (ASCII input). */
function clampShortDescription(candidate: string): string {
  return candidate.length > 64 ? candidate.slice(0, 64) : candidate;
}

export function renderSkillMd(answers: SkillAnswers): string {
  const lines: string[] = [
    "---",
    `name: ${answers.name}`,
    `description: ${quote(answers.description)}`,
  ];
  if (answers.implicit) {
    lines.push("allowed-tools:");
    for (const tool of READ_ONLY_TOOLS) {
      lines.push(`  - ${tool}`);
    }
  } else {
    lines.push("disable-model-invocation: true");
  }
  lines.push(
    `display-name: ${quote(answers.displayName)}`,
    `short-description: ${quote(answers.shortDescription)}`,
    `color: ${quote(answers.color)}`,
    `icon: ${answers.icon}`,
    `default-prompt: ${quote(answers.defaultPrompt)}`,
    `implicit: ${answers.implicit}`,
    "---",
    "",
    ...skillBody(answers.displayName),
    "",
  );
  return lines.join("\n");
}

// NOTE: never mention a `references/…`, `scripts/…` or `steps/…` path in this
// body — check requires every mentioned path to exist on disk.
function skillBody(displayName: string): string[] {
  return [
    `# ${displayName}`,
    "",
    "## Objective",
    "",
    "State in one or two sentences what this skill delivers and for whom.",
    "Replace every placeholder line of this template before committing.",
    "",
    "## Procedure",
    "",
    "1. Gather the inputs: name the files, commands or context the skill needs.",
    "2. Do the work: describe each step precisely enough to be reproducible.",
    "3. Produce the output: state the exact artifact or answer the skill returns.",
    "",
    "## Verification",
    "",
    "- Give the command that proves the skill worked, and its expected output.",
    "- State what must NOT have changed (files untouched, no side effects).",
    "",
    "## Notes",
    "",
    "- Keep the body under 500 significant lines; move depth into a references folder.",
    "- Cross-invoke other skills only with their exact `$<name>` token.",
  ];
}

/** YAML double-quoted scalar, same escaping as the Codex renderers. */
export function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
