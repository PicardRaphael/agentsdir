import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as prompts from "@clack/prompts";
import { defineCommand } from "citty";
import {
  ICON_NAMES,
  renderOpenAiYaml,
  renderSkillIcon,
} from "../core/codex-metadata.js";
import { CliError } from "../core/errors.js";
import { parseSkillMarkdown } from "../core/frontmatter.js";
import { resolveRepoRoot } from "../core/repo.js";
import { validateSkillFolder } from "../core/validate.js";
import { EXIT_CODES } from "../exit-codes.js";
import {
  defaultSkillAnswers,
  renderSkillMd,
  type SkillAnswers,
} from "../templates/skill.js";
import {
  ensureAnswer,
  ensureValidName,
  ensureWritable,
  isInteractive,
  renderGeneratorReport,
  resyncProjections,
  runGeneratorCli,
  type GeneratorResult,
  type GeneratorTarget,
} from "./add-common.js";

/** Answers a caller can give on the command line instead of at the prompt. */
export interface SkillFlags {
  description?: string;
  displayName?: string;
  shortDescription?: string;
  color?: string;
  icon?: string;
  defaultPrompt?: string;
}

/**
 * What each answer must satisfy — used by the prompt that asks it *and* by the
 * flag that replaces it. One rule per field, in one place: a flag can never
 * accept what the prompt refuses, which would move the refusal all the way down
 * to a frontmatter parse error with a far worse message.
 */
const SKILL_RULES: Record<
  keyof SkillFlags,
  {
    flag: string;
    validate: (value: string, name: string) => string | undefined;
  }
> = {
  description: {
    flag: "description",
    validate: (value) =>
      value.trim() === "" ? "A description is required." : undefined,
  },
  displayName: {
    flag: "display-name",
    validate: (value) =>
      value.trim() === "" ? "A display name is required." : undefined,
  },
  shortDescription: {
    flag: "short-description",
    validate: (value) => {
      const length = [...value].length;
      return length < 25 || length > 64
        ? `25 to 64 characters required; got ${length}.`
        : undefined;
    },
  },
  color: {
    flag: "color",
    validate: (value) =>
      /^#[0-9A-Fa-f]{6}$/.test(value)
        ? undefined
        : "A #RRGGBB hex color is required.",
  },
  icon: {
    flag: "icon",
    validate: (value) =>
      ICON_NAMES.includes(value)
        ? undefined
        : `Unknown icon "${value}" — known icons: ${ICON_NAMES.join(", ")}.`,
  },
  defaultPrompt: {
    flag: "default-prompt",
    validate: (value, name) =>
      new RegExp(`\\$${name}(?![a-z0-9-])`).test(value)
        ? undefined
        : `The prompt must contain the exact token $${name}.`,
  },
};

/** Usage error (exit 2) when a flag carries what its prompt would have refused. */
export function ensureValidSkillFlags(flags: SkillFlags, name: string): void {
  for (const [field, rule] of Object.entries(SKILL_RULES) as [
    keyof SkillFlags,
    (typeof SKILL_RULES)[keyof SkillFlags],
  ][]) {
    const value = flags[field];
    if (value === undefined) {
      continue;
    }
    const problem = rule.validate(value, name);
    if (problem !== undefined) {
      throw new CliError(`--${rule.flag}: ${problem}`);
    }
  }
}

/** A flag that was given, as the one-key object the answers spread expects. */
function text(
  field: keyof SkillFlags,
  value: unknown,
): Partial<Record<keyof SkillFlags, string>> {
  return typeof value === "string" && value !== "" ? { [field]: value } : {};
}

/** What `add skill <name>` would create, and why it would refuse to. */
export function skillTarget(name: string): GeneratorTarget {
  return {
    path: `.agents/skills/${name}`,
    refusal: `Skill "${name}" already exists (.agents/skills/${name}/). Pick another name, or edit the existing SKILL.md and run \`agentsdir sync\`.`,
  };
}

/** `--implicit` is refused without the explicit read-only declaration. */
export function ensureImplicitIsReadOnly(flags: {
  implicit: boolean;
  readOnly: boolean;
}): void {
  if (flags.implicit && !flags.readOnly) {
    throw new CliError(
      "--implicit is refused unless the skill is explicitly declared read-only: only a read-only skill may be implicitly invocable on every harness at once. Re-run with --implicit --read-only if the skill never writes.",
    );
  }
}

/**
 * Creates `.agents/skills/<name>/` from validated answers: SKILL.md (the
 * catalogue) plus the two Codex artifacts, rendered before any write so a
 * refused run writes nothing — then runs check's validation pass on the result.
 */
export async function runAddSkill(
  root: string,
  answers: SkillAnswers,
  options: { dryRun: boolean },
): Promise<GeneratorResult> {
  ensureValidName("skill", answers.name);
  const manifest = await ensureWritable(root, skillTarget(answers.name));
  const skillDir = join(root, ".agents", "skills", answers.name);
  const source = renderSkillMd(answers);
  // parses and validates every frontmatter invariant before anything is written
  const { frontmatter } = parseSkillMarkdown(source);
  const files: [string, string][] = [
    ["SKILL.md", source],
    ["agents/openai.yaml", renderOpenAiYaml(frontmatter)],
    ["assets/icon.svg", renderSkillIcon(frontmatter)],
  ];
  if (!options.dryRun) {
    for (const [rel, content] of files) {
      const abs = join(skillDir, ...rel.split("/"));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
    const violations = (await validateSkillFolder(root, answers.name)).filter(
      (violation) => violation.severity === "error",
    );
    if (violations.length > 0) {
      throw new CliError(
        violations
          .map((violation) => `${violation.path}: ${violation.message}`)
          .join("\n"),
        EXIT_CODES.driftOrInvariant,
      );
    }
  }
  return {
    changes: [
      ...files.map(([rel]) => ({
        path: `.agents/skills/${answers.name}/${rel}`,
        action: "created" as const,
      })),
      ...(await resyncProjections(root, manifest, {
        ...options,
        overlay: Object.fromEntries(
          files.map(([rel, content]) => [
            `.agents/skills/${answers.name}/${rel}`,
            content,
          ]),
        ),
      })),
    ],
    exitCode: EXIT_CODES.ok,
    mode: manifest.projections.mode,
  };
}

/**
 * Interview of the catalogue fields. Every question has a flag, and a flag
 * given skips only its own question: without a TTY — the agent path the README
 * puts forward — a flag is the only way to give a real answer rather than a
 * guessed one (`docs/commandes.md`). What no flag answers falls back to the
 * template defaults, which are valid but generic.
 */
export async function collectSkillAnswers(
  name: string,
  implicit: boolean,
  flags: SkillFlags = {},
): Promise<SkillAnswers> {
  const defaults = defaultSkillAnswers(name, implicit);
  const rule = (field: keyof SkillFlags) => SKILL_RULES[field].validate;
  if (!isInteractive()) {
    const unanswered = (
      Object.keys(SKILL_RULES) as (keyof SkillFlags)[]
    ).filter((field) => flags[field] === undefined);
    if (unanswered.length > 0) {
      console.error(
        `stdin is not a TTY — using template defaults for ${unanswered
          .map((field) => `--${SKILL_RULES[field].flag}`)
          .join(", ")}.`,
      );
    }
    return { ...defaults, ...definedFlags(flags) };
  }
  prompts.intro(`agentsdir add skill ${name}`);
  const description =
    flags.description ??
    ensureAnswer(
      await prompts.text({
        message: 'Description — triggers first ("Use when…")?',
        initialValue: defaults.description,
        validate: (value) => rule("description")(value ?? "", name),
      }),
      "add skill",
    );
  const displayName =
    flags.displayName ??
    ensureAnswer(
      await prompts.text({
        message: "Display name?",
        initialValue: defaults.displayName,
        validate: (value) => rule("displayName")(value ?? "", name),
      }),
      "add skill",
    );
  const shortDescription =
    flags.shortDescription ??
    ensureAnswer(
      await prompts.text({
        message: "Short description (25 to 64 characters)?",
        initialValue: defaults.shortDescription,
        validate: (value) => rule("shortDescription")(value ?? "", name),
      }),
      "add skill",
    );
  const color =
    flags.color ??
    ensureAnswer(
      await prompts.text({
        message: "Color (#RRGGBB)?",
        initialValue: defaults.color,
        validate: (value) => rule("color")(value ?? "", name),
      }),
      "add skill",
    );
  const icon =
    flags.icon ??
    ensureAnswer(
      await prompts.select({
        message: "Icon (embedded set)?",
        options: ICON_NAMES.map((iconName) => ({
          value: iconName,
          label: iconName,
        })),
        initialValue: defaults.icon,
      }),
      "add skill",
    );
  const defaultPrompt =
    flags.defaultPrompt ??
    ensureAnswer(
      await prompts.text({
        message: `Default prompt (must contain $${name})?`,
        initialValue: defaults.defaultPrompt,
        validate: (value) => rule("defaultPrompt")(value ?? "", name),
      }),
      "add skill",
    );
  prompts.outro("Answers collected.");
  return {
    name,
    description,
    displayName,
    shortDescription,
    color,
    icon,
    defaultPrompt,
    implicit,
  };
}

/** Only the fields a flag actually carried; `undefined` must not shadow a default. */
function definedFlags(flags: SkillFlags): Partial<SkillAnswers> {
  return Object.fromEntries(
    Object.entries(flags).filter(([, value]) => value !== undefined),
  ) as Partial<SkillAnswers>;
}

export const addSkillCommand = defineCommand({
  meta: {
    name: "skill",
    description:
      "Create a conforming skill in .agents/skills/ with its Codex projections",
  },
  args: {
    name: {
      type: "positional",
      description: "Skill name (kebab-case)",
      required: true,
    },
    implicit: {
      type: "boolean",
      description:
        "Allow implicit invocation (requires the --read-only declaration)",
    },
    "read-only": {
      type: "boolean",
      description: "Declare the skill read-only (required by --implicit)",
    },
    description: {
      type: "string",
      description: 'Trigger-oriented description ("Use when…")',
    },
    "display-name": { type: "string", description: "Display name" },
    "short-description": {
      type: "string",
      description: "Short description (25 to 64 characters)",
    },
    color: { type: "string", description: "Color (#RRGGBB)" },
    icon: {
      type: "string",
      description: `Icon from the embedded set (${ICON_NAMES.join(", ")})`,
    },
    "default-prompt": {
      type: "string",
      description: "Default prompt (must contain the $<name> token)",
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
    await runGeneratorCli("add skill", args.json === true, async () => {
      const root = await resolveRepoRoot(process.cwd());
      const name = String(args.name);
      ensureValidName("skill", name);
      ensureImplicitIsReadOnly({
        implicit: args.implicit === true,
        readOnly: args["read-only"] === true,
      });
      const flags: SkillFlags = {
        ...text("description", args.description),
        ...text("displayName", args["display-name"]),
        ...text("shortDescription", args["short-description"]),
        ...text("color", args.color),
        ...text("icon", args.icon),
        ...text("defaultPrompt", args["default-prompt"]),
      };
      ensureValidSkillFlags(flags, name);
      // the refusals come before the first question: retyping a taken name, or
      // running this before `init`, must not cost six answers first
      await ensureWritable(root, skillTarget(name));
      const answers = await collectSkillAnswers(
        name,
        args.implicit === true,
        flags,
      );
      const result = await runAddSkill(root, answers, { dryRun });
      return { result, report: renderGeneratorReport(result, { dryRun }) };
    });
  },
});
