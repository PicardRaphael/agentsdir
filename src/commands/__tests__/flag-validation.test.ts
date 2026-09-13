import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../exit-codes.js";
import { ensureValidAgentDescription } from "../add-agent.js";
import { renderGeneratorReport, type GeneratorResult } from "../add-common.js";
import { ensureValidRuleHook } from "../add-rule.js";
import { ensureValidSkillFlags } from "../add-skill.js";
import { renderReport } from "../init.js";
import type { InitAnswers } from "../init-interview.js";
import type { InitResult, PlannedWrite } from "../init.js";

/**
 * Two things a user meets before anything else, and neither had a test.
 *
 * The first is the report `init` prints: the first screen of this product, and
 * the three lines telling a newcomer what to run next. The second is what the
 * CLI answers when a flag carries something a prompt would have refused — the
 * only place these validators are reachable without a terminal, and they were
 * exercised only in a sub-process, where the coverage of a wrong message is
 * nobody's.
 */

function answers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    productName: "demo",
    description: "A demo product.",
    commands: { test: "npm test" },
    unverified: {},
    harnesses: ["claude", "codex"],
    packs: ["core"],
    mode: "copy",
    stacks: [],
    ...overrides,
  };
}

function initResult(overrides: Partial<InitResult> = {}): InitResult {
  return {
    exitCode: EXIT_CODES.ok,
    alreadyInitialized: false,
    changes: [],
    ...overrides,
  };
}

function write(path: string, action: PlannedWrite["action"]): PlannedWrite {
  return { path, action };
}

/** The message of the CliError a validator threw, or undefined when it allowed the value. */
function refusalOf(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("init - the first screen of the product", () => {
  it("Given a repository already initialized, When the report is rendered, Then it names the command to run instead of a plan", () => {
    const report = renderReport(
      initResult({ alreadyInitialized: true }),
      answers(),
      { dryRun: false },
    );

    expect(report).toBe(
      "Already initialized — run `agentsdir sync` to regenerate.",
    );
  });

  it("Given a real install, When the report is rendered, Then it states what was written and the decisions that shaped it", () => {
    const report = renderReport(
      initResult({
        changes: [
          write("AGENTS.md", "create"),
          write(".agents.toml", "create"),
        ],
      }),
      answers({ mode: "symlink", harnesses: ["claude", "cursor"] }),
      { dryRun: false },
    );

    expect(report).toContain("Installed:");
    expect(report).toContain("AGENTS.md");
    // the three decisions a user must be able to read back without opening the
    // manifest: they are what every later command derives its behaviour from
    expect(report).toContain("Projection mode: symlink");
    expect(report).toContain("Harnesses: claude, cursor");
    expect(report).toContain("Packs: core");
  });

  it("Given a dry run, When the report is rendered, Then it announces planned writes and never claims an install", () => {
    const report = renderReport(
      initResult({ changes: [write("AGENTS.md", "create")] }),
      answers(),
      { dryRun: true },
    );

    expect(report).toContain("Dry run — nothing was written. Planned writes:");
    expect(report).not.toContain("Installed:");
  });

  it("Given the creator pack installed, When the report is rendered, Then the first suggested move is the proposal that fills the empty structure", () => {
    const report = renderReport(
      initResult(),
      answers({ packs: ["core", "creator"] }),
      { dryRun: false },
    );

    const steps = report.slice(report.indexOf("Next steps:"));
    expect(steps).toContain("$propose-setup");
    // and it comes first: a generator the user has to aim by hand is the wrong
    // thing to suggest to someone who has just installed an empty structure
    expect(steps.indexOf("$propose-setup")).toBeLessThan(
      steps.indexOf("add skill"),
    );
  });

  it("Given the creator pack left out, When the report is rendered, Then no meta-skill is suggested that the repository does not have", () => {
    const report = renderReport(initResult(), answers({ packs: ["core"] }), {
      dryRun: false,
    });

    expect(report).not.toContain("$propose-setup");
    expect(report).toContain("npx agentsdir add skill <name>");
    expect(report).toContain("npx agentsdir check");
  });
});

describe("generators - the report they print", () => {
  it("Given a generator run, When its report is rendered, Then each action lines up in one column", () => {
    const result: GeneratorResult = {
      changes: [
        { path: ".agents/rules/a.md", action: "created" },
        { path: "AGENTS.md", action: "updated" },
        { path: ".claude/rules/gone.md", action: "removed" },
      ],
      exitCode: EXIT_CODES.ok,
      mode: "copy",
    };

    const report = renderGeneratorReport(result, { dryRun: false });

    expect(report).toContain("Done:");
    expect(report).toContain("  created  .agents/rules/a.md");
    expect(report).toContain("  updated  AGENTS.md");
    expect(report).toContain("  removed  .claude/rules/gone.md");
  });

  it("Given a dry run, When the report is rendered, Then it announces a plan and not a write", () => {
    const report = renderGeneratorReport(
      { changes: [], exitCode: EXIT_CODES.ok, mode: "copy" },
      { dryRun: true },
    );

    expect(report).toContain("Dry run — nothing was written. Full plan:");
    expect(report).not.toContain("Done:");
  });
});

describe("generators - a flag that carries what a prompt would have refused", () => {
  it("Given a flag left out entirely, When the flags are validated, Then nothing is refused", () => {
    // absent is not empty: an absent flag falls back to the template default,
    // and only a *given* value reaches the validator
    expect(refusalOf(() => ensureValidSkillFlags({}, "demo-skill"))).toBe(
      undefined,
    );
    expect(refusalOf(() => ensureValidRuleHook(undefined))).toBe(undefined);
    expect(refusalOf(() => ensureValidAgentDescription(undefined))).toBe(
      undefined,
    );
  });

  it("Given a flag given empty, When it is validated, Then the refusal names the flag the user typed", () => {
    // the flag name is the whole value of the message: "a description is
    // required" without "--description:" leaves the user guessing which of the
    // six flags of `add skill` it is about
    expect(
      refusalOf(() =>
        ensureValidSkillFlags({ description: "   " }, "demo-skill"),
      ),
    ).toBe("--description: A description is required.");
    expect(
      refusalOf(() => ensureValidSkillFlags({ displayName: "" }, "demo-skill")),
    ).toBe("--display-name: A display name is required.");
    expect(refusalOf(() => ensureValidRuleHook("  "))).toBe(
      "--hook: the sentence is required.",
    );
    expect(refusalOf(() => ensureValidAgentDescription(""))).toBe(
      "--description: a description is required.",
    );
  });

  it("Given a flag refused, When the error is raised, Then it is a usage error, not a drift", () => {
    let thrown: unknown;
    try {
      ensureValidRuleHook("");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { exitCode: number }).exitCode).toBe(
      EXIT_CODES.environmentOrUsage,
    );
  });

  it("Given a short description outside its bounds, When it is validated, Then both ends are refused and the count is reported", () => {
    const short = "a".repeat(24);
    const long = "a".repeat(65);

    expect(
      refusalOf(() =>
        ensureValidSkillFlags({ shortDescription: short }, "demo-skill"),
      ),
    ).toBe("--short-description: 25 to 64 characters required; got 24.");
    expect(
      refusalOf(() =>
        ensureValidSkillFlags({ shortDescription: long }, "demo-skill"),
      ),
    ).toBe("--short-description: 25 to 64 characters required; got 65.");
    // both bounds are inclusive
    for (const length of [25, 64]) {
      expect(
        refusalOf(() =>
          ensureValidSkillFlags(
            { shortDescription: "a".repeat(length) },
            "demo-skill",
          ),
        ),
      ).toBe(undefined);
    }
  });

  it("Given a short description of astral characters, When it is measured, Then it is counted in characters, not in UTF-16 units", () => {
    // 40 emoji are 40 characters to a reader and 80 to `.length`: counting in
    // UTF-16 units would refuse a description that is comfortably within bounds
    expect(
      refusalOf(() =>
        ensureValidSkillFlags({ shortDescription: "🙂".repeat(40) }, "demo"),
      ),
    ).toBe(undefined);
    // and the bound still applies, measured the same way
    expect(
      refusalOf(() =>
        ensureValidSkillFlags({ shortDescription: "🙂".repeat(70) }, "demo"),
      ),
    ).toBe("--short-description: 25 to 64 characters required; got 70.");
  });

  it("Given a colour that is not a six-digit hex, When it is validated, Then it is refused whatever shape it takes", () => {
    for (const colour of ["red", "#abc", "#GGGGGG", "abcdef", "#abcdef0"]) {
      expect(
        refusalOf(() => ensureValidSkillFlags({ color: colour }, "demo")),
      ).toBe("--color: A #RRGGBB hex color is required.");
    }
    for (const colour of ["#abcdef", "#ABCDEF", "#012345"]) {
      expect(
        refusalOf(() => ensureValidSkillFlags({ color: colour }, "demo")),
      ).toBe(undefined);
    }
  });

  it("Given an icon that is not in the vendored set, When it is validated, Then the refusal lists what it can have instead", () => {
    const refusal = refusalOf(() =>
      ensureValidSkillFlags({ icon: "nonesuch" }, "demo"),
    );

    expect(refusal).toContain('--icon: Unknown icon "nonesuch"');
    expect(refusal).toContain("known icons:");
  });

  it("Given a default prompt, When its token is validated, Then only the exact skill name counts", () => {
    // the token is what invokes the skill: `$demo-skill` and `$demo` are two
    // different skills, and a prompt naming the wrong one silently never fires
    const valid = (value: string): string | undefined =>
      refusalOf(() =>
        ensureValidSkillFlags({ defaultPrompt: value }, "demo-skill"),
      );

    expect(valid("Run $demo-skill on this repo.")).toBe(undefined);
    expect(valid("Run $demo-skill, then stop.")).toBe(undefined);
    expect(valid("Run $demo on this repo.")).toBe(
      "--default-prompt: The prompt must contain the exact token $demo-skill.",
    );
    expect(valid("Run $demo-skill-more on this repo.")).toBe(
      "--default-prompt: The prompt must contain the exact token $demo-skill.",
    );
    expect(valid("Run the skill on this repo.")).toBe(
      "--default-prompt: The prompt must contain the exact token $demo-skill.",
    );
  });

  it("Given several flags wrong at once, When they are validated, Then the first refusal stops the run", () => {
    // a generator that reported six problems at once would still write nothing;
    // what matters is that it refuses before any write, and names one cause
    const refusal = refusalOf(() =>
      ensureValidSkillFlags(
        { description: "", color: "nope", icon: "nonesuch" },
        "demo",
      ),
    );

    expect(refusal).toBe("--description: A description is required.");
  });
});
