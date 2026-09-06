import { basename } from "node:path";
import * as prompts from "@clack/prompts";
import {
  detectGitSymlinks,
  detectStack,
  detectSymlinkSupport,
  type StackAction,
  type StackCommands,
} from "../core/detect.js";
import { CliError } from "../core/errors.js";
import { HARNESSES } from "../core/harnesses.js";
import { parseMode, type ProjectionMode } from "../core/manifest.js";
import { PACKS } from "../packs/index.js";

/**
 * Everything `init` asks and infers before a single byte is planned: the
 * interview, the flags it can be replaced by, and the environment probes that
 * fill the defaults. Separate from the writing side so the questions can change
 * without touching the plan, and so the plan can be tested without a terminal.
 */

export interface InitAnswers {
  productName: string;
  description: string;
  /** Commands somebody or something vouched for: a flag, an answer, or the repo. */
  commands: StackCommands;
  /**
   * Commands the stack usually runs that nothing here confirms. They reach
   * `AGENTS.md` marked as to be completed, never as statements — the file's
   * whole job is to tell agents the truth about this repository.
   */
  unverified: StackCommands;
  harnesses: string[];
  packs: string[];
  mode: ProjectionMode;
  stacks: string[];
}

/**
 * Every answer the interview collects has a flag, so a caller that already
 * knows the repository can install without a terminal. That caller is often a
 * coding agent asked to "install agentsdir here": it has read the README, the
 * scripts and the CI, so it answers better than a default ever could — but only
 * if it has somewhere to put the answers.
 */
export interface InitFlags {
  yes: boolean;
  name?: string;
  description?: string;
  dev?: string;
  test?: string;
  lint?: string;
  harness?: string;
  packs?: string;
  mode?: string;
}

/** Collects the interview answers, or the defaults with `--yes` / no TTY. */
export async function collectAnswers(
  root: string,
  flags: InitFlags,
): Promise<InitAnswers> {
  const stacks = await detectStack(root);
  const stackIds = stacks.map((stack) => stack.id);
  // a flag is an assertion by the caller, and what the repo declares is read
  // from it: both count as verified. What is left is the stack's convention,
  // which nothing here confirms.
  const flagged: StackCommands = {
    ...(flags.dev === undefined ? {} : { dev: flags.dev }),
    ...(flags.test === undefined ? {} : { test: flags.test }),
    ...(flags.lint === undefined ? {} : { lint: flags.lint }),
  };
  const commands: StackCommands = {
    ...(stacks[0]?.commands ?? {}),
    ...flagged,
  };
  const unverified: StackCommands = {};
  for (const [action, convention] of Object.entries(
    stacks[0]?.unverified ?? {},
  ) as [StackAction, string][]) {
    if (commands[action] === undefined) {
      unverified[action] = convention;
    }
  }
  const defaults: InitAnswers = {
    productName: flags.name ?? basename(root),
    description: flags.description ?? "",
    commands,
    unverified,
    harnesses:
      flags.harness === undefined
        ? [...HARNESSES]
        : parseList(flags.harness, HARNESSES, "--harness"),
    packs:
      flags.packs === undefined
        ? ["core", "creator"]
        : withCore(parseList(flags.packs, PACKS, "--packs")),
    mode:
      flags.mode === undefined ? await detectMode(root) : parseMode(flags.mode),
    stacks: stackIds,
  };
  const interactive =
    !flags.yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) {
    if (!flags.yes) {
      console.error("stdin is not a TTY — using defaults (same as --yes).");
    }
    return defaults;
  }
  prompts.intro("agentsdir init");
  const productName =
    flags.name ??
    ensureAnswer(
      await prompts.text({
        message: "Product name?",
        initialValue: defaults.productName,
      }),
    );
  const description =
    flags.description ??
    ensureAnswer(
      await prompts.text({
        message: "One-sentence description?",
        defaultValue: "",
        placeholder: "What this product does",
      }),
    );
  // the prompt is exactly where an unconfirmed convention belongs: someone is
  // there to accept or correct it, and whatever comes back is their answer
  const dev =
    flags.dev ??
    (await askCommand(
      "Dev command? (leave empty to skip)",
      defaults.commands.dev ?? defaults.unverified.dev,
    ));
  const test =
    flags.test ??
    (await askCommand(
      "Test command? (leave empty to skip)",
      defaults.commands.test ?? defaults.unverified.test,
    ));
  const lint =
    flags.lint ??
    (await askCommand(
      "Lint command? (leave empty to skip)",
      defaults.commands.lint ?? defaults.unverified.lint,
    ));
  let harnesses = defaults.harnesses;
  if (flags.harness === undefined) {
    harnesses = ensureAnswer(
      await prompts.multiselect({
        message: "Target harnesses?",
        options: HARNESSES.map((name) => ({
          value: name as string,
          label: name,
        })),
        initialValues: [...HARNESSES] as string[],
        required: true,
      }),
    );
  }
  let packs = defaults.packs;
  if (flags.packs === undefined) {
    const optional = ensureAnswer(
      await prompts.multiselect({
        message: "Packs to install? (core is always installed)",
        options: PACKS.filter((name) => name !== "core").map((name) => ({
          value: name as string,
          label: name,
        })),
        initialValues: ["creator"],
        required: false,
      }),
    );
    packs = withCore(optional);
  }
  prompts.outro("Answers collected.");
  return {
    productName,
    description,
    commands: { dev, test, lint },
    // every command was asked or flagged: nothing is left unconfirmed
    unverified: {},
    harnesses,
    packs,
    mode: defaults.mode,
    stacks: stackIds,
  };
}

async function detectMode(root: string): Promise<ProjectionMode> {
  const support = await detectSymlinkSupport(root);
  if (!support.supported) {
    return "copy";
  }
  const git = await detectGitSymlinks(root);
  return git.coreSymlinks === "false" ? "copy" : "symlink";
}

function parseList(
  raw: string,
  allowed: readonly string[],
  flag: string,
): string[] {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (values.length === 0) {
    throw new CliError(
      `${flag} needs at least one value (allowed: ${allowed.join(", ")}).`,
    );
  }
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new CliError(
        `Unknown value "${value}" for ${flag} (allowed: ${allowed.join(", ")}).`,
      );
    }
  }
  return [...new Set(values)];
}

function withCore(packs: string[]): string[] {
  return packs.includes("core") ? packs : ["core", ...packs];
}

async function askCommand(
  message: string,
  initial: string | undefined,
): Promise<string | undefined> {
  const value = ensureAnswer(
    await prompts.text({
      message,
      initialValue: initial ?? "",
      defaultValue: "",
    }),
  );
  return value === "" ? undefined : value;
}

function ensureAnswer<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) {
    prompts.cancel("Init cancelled.");
    throw new CliError("Init cancelled.");
  }
  return value as T;
}
