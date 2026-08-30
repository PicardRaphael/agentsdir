import { pathExists } from "../core/fs-utils.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineCommand } from "citty";
import { CliError } from "../core/errors.js";
import {
  HOOK_EVENTS,
  HOOK_HARNESSES,
  HOOKS_DIR,
  planHookRegistrations,
  resolveHookEvent,
  supportedHarnesses,
  type HookEventSpec,
} from "../core/hook-registries.js";
import { readManifest } from "../core/manifest.js";
import { resolveRepoRoot } from "../core/repo.js";
import { EXIT_CODES } from "../exit-codes.js";
import { renderHookScript } from "../templates/hook.js";
import {
  ensureValidName,
  renderGeneratorReport,
  resyncProjections,
  runGeneratorCli,
  type GeneratorChange,
  type GeneratorResult,
} from "./add-common.js";

export const DEFAULT_HOOK_SLUG = "hook";

export interface AddHookResult extends GeneratorResult {
  /** Human notes (partial harness support, dropped Cursor matcher) — stderr, never stdout. */
  warnings: string[];
}

/** Usage error (exit 2) when the event is unknown to every harness. */
export function resolveHookEventOrFail(input: string): HookEventSpec {
  const event = resolveHookEvent(input);
  if (event === undefined) {
    throw new CliError(
      `Unknown hook event "${input}" — known events: ${HOOK_EVENTS.map((entry) => entry.name).join(", ")}.`,
    );
  }
  return event;
}

/**
 * Writes the portable script once and registers it on every enabled harness
 * that supports the event. The whole plan — script and merged registration
 * files — is computed before any write, so a refused run writes nothing.
 */
export async function runAddHook(
  root: string,
  answers: { event: HookEventSpec; slug: string; matcher: string | undefined },
  options: { dryRun: boolean },
): Promise<AddHookResult> {
  ensureValidName("hook", answers.slug);
  const manifest = await readManifest(root);
  const enabled = manifest.harness.enabled;
  const supported = supportedHarnesses(answers.event);
  const targets = supported.filter((harness) => enabled.includes(harness));
  if (targets.length === 0) {
    throw new CliError(
      `Event ${answers.event.name} is supported by ${supported.join(", ")}, but none of them is enabled in the manifest — nothing to register.`,
    );
  }
  const file = `${answers.event.name.toLowerCase()}-${answers.slug}.mjs`;
  const scriptPath = `${HOOKS_DIR}/${file}`;
  if (await pathExists(join(root, ...scriptPath.split("/")))) {
    throw new CliError(
      `Hook script ${scriptPath} already exists. Pick another name with --name, or edit the existing script — \`sync\` keeps the registrations in step.`,
    );
  }
  const script = renderHookScript({
    event: answers.event.name,
    matcher: answers.matcher,
  });
  const registries = await planHookRegistrations(root, enabled, {
    [scriptPath]: script,
  });
  const changes: GeneratorChange[] = [{ path: scriptPath, action: "created" }];
  for (const plan of registries) {
    if (plan.action !== "ok") {
      changes.push({ path: plan.path, action: plan.action });
    }
  }
  if (!options.dryRun) {
    await mkdir(join(root, ".agents", "hooks"), { recursive: true });
    await writeFile(join(root, ...scriptPath.split("/")), script, "utf8");
    for (const plan of registries) {
      if (plan.action === "ok" || plan.content === undefined) {
        continue;
      }
      const abs = join(root, ...plan.path.split("/"));
      await mkdir(join(root, ...plan.path.split("/").slice(0, -1)), {
        recursive: true,
      });
      await writeFile(abs, plan.content, "utf8");
    }
  }
  const warnings: string[] = [];
  const skipped = HOOK_HARNESSES.filter(
    (harness) => enabled.includes(harness) && !targets.includes(harness),
  );
  if (skipped.length > 0) {
    warnings.push(
      `Event ${answers.event.name} is not supported by ${skipped.join(", ")} — registered on ${targets.join(", ")} only.`,
    );
  }
  if (answers.matcher !== undefined && targets.includes("cursor")) {
    warnings.push(
      "Cursor matchers use a different tool vocabulary — registered there without the matcher (the script still receives the payload and can filter itself).",
    );
  }
  return {
    // .agents/hooks/ is not a projected directory, so this closing step only
    // catches staleness and orphans left by earlier writes — same contract as
    // the other generators
    changes: [
      ...changes,
      ...(await resyncProjections(root, manifest, options)),
    ],
    exitCode: EXIT_CODES.ok,
    mode: manifest.projections.mode,
    warnings,
  };
}

export const addHookCommand = defineCommand({
  meta: {
    name: "hook",
    description:
      "Create one portable hook script and register it on every enabled harness",
  },
  args: {
    event: {
      type: "positional",
      description: `Hook event (${HOOK_EVENTS.map((entry) => entry.name).join(", ")})`,
      required: true,
    },
    name: {
      type: "string",
      description: `Slug of the script file (kebab-case, default: ${DEFAULT_HOOK_SLUG})`,
    },
    matcher: {
      type: "string",
      description:
        "Tool matcher written into the Claude Code and Codex registrations",
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
    await runGeneratorCli("add hook", args.json === true, async () => {
      const root = await resolveRepoRoot(process.cwd());
      const event = resolveHookEventOrFail(String(args.event));
      const slug =
        typeof args.name === "string" && args.name !== ""
          ? args.name
          : DEFAULT_HOOK_SLUG;
      ensureValidName("hook", slug);
      const matcher =
        typeof args.matcher === "string" && args.matcher !== ""
          ? args.matcher
          : undefined;
      const result = await runAddHook(
        root,
        { event, slug, matcher },
        { dryRun },
      );
      for (const warning of result.warnings) {
        console.error(warning);
      }
      return { result, report: renderGeneratorReport(result, { dryRun }) };
    });
  },
});
