import { entryExists } from "../core/fs-utils.js";
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
import { readManifest } from "../core/manifest.js";
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
  isInteractive,
  renderGeneratorReport,
  resyncProjections,
  runGeneratorCli,
  type GeneratorResult,
} from "./add-common.js";

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
  const manifest = await readManifest(root);
  const skillDir = join(root, ".agents", "skills", answers.name);
  if (await entryExists(skillDir)) {
    throw new CliError(
      `Skill "${answers.name}" already exists (.agents/skills/${answers.name}/). Pick another name, or edit the existing SKILL.md and run \`agentsdir sync\`.`,
    );
  }
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

/** Interview of the catalogue fields; scripts and CI get valid defaults. */
export async function collectSkillAnswers(
  name: string,
  implicit: boolean,
): Promise<SkillAnswers> {
  const defaults = defaultSkillAnswers(name, implicit);
  if (!isInteractive()) {
    console.error("stdin is not a TTY — using template defaults.");
    return defaults;
  }
  prompts.intro(`agentsdir add skill ${name}`);
  const description = ensureAnswer(
    await prompts.text({
      message: 'Description — triggers first ("Use when…")?',
      initialValue: defaults.description,
      validate: (value) =>
        (value ?? "").trim() === "" ? "A description is required." : undefined,
    }),
    "add skill",
  );
  const displayName = ensureAnswer(
    await prompts.text({
      message: "Display name?",
      initialValue: defaults.displayName,
      validate: (value) =>
        (value ?? "").trim() === "" ? "A display name is required." : undefined,
    }),
    "add skill",
  );
  const shortDescription = ensureAnswer(
    await prompts.text({
      message: "Short description (25 to 64 characters)?",
      initialValue: defaults.shortDescription,
      validate: (value) => {
        const length = [...(value ?? "")].length;
        return length < 25 || length > 64
          ? `25 to 64 characters required; got ${length}.`
          : undefined;
      },
    }),
    "add skill",
  );
  const color = ensureAnswer(
    await prompts.text({
      message: "Color (#RRGGBB)?",
      initialValue: defaults.color,
      validate: (value) =>
        /^#[0-9A-Fa-f]{6}$/.test(value ?? "")
          ? undefined
          : "A #RRGGBB hex color is required.",
    }),
    "add skill",
  );
  const icon = ensureAnswer(
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
  const token = new RegExp(`\\$${name}(?![a-z0-9-])`);
  const defaultPrompt = ensureAnswer(
    await prompts.text({
      message: `Default prompt (must contain $${name})?`,
      initialValue: defaults.defaultPrompt,
      validate: (value) =>
        token.test(value ?? "")
          ? undefined
          : `The prompt must contain the exact token $${name}.`,
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
      const answers = await collectSkillAnswers(name, args.implicit === true);
      const result = await runAddSkill(root, answers, { dryRun });
      return { result, report: renderGeneratorReport(result, { dryRun }) };
    });
  },
});
