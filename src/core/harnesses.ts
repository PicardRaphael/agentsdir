/**
 * The harnesses this version targets. One list, so `init`, the hook registries
 * and the diagnostics can never disagree on what "every harness" means.
 * Adding a fourth one is a settled-decision change, not a casual edit: see
 * docs/SPEC.md.
 */
export const HARNESSES = ["claude", "codex", "cursor"] as const;

export type Harness = (typeof HARNESSES)[number];

/** Directory each harness keeps its own configuration in, at the repo root. */
export const HARNESS_DIRS: Record<Harness, string> = {
  claude: ".claude",
  codex: ".codex",
  cursor: ".cursor",
};

/**
 * Everything agentsdir needs to know about one harness, in one place.
 *
 * The point is the cost of adding a fourth: it used to mean editing the twelve
 * hook events (one boolean field each), the projection engine, the detection
 * probes and the `includes("claude")` guards scattered across the commands.
 * A harness now declares itself here, once, and every one of those derives
 * from the declaration instead of naming the harness.
 */
export interface HarnessSpec {
  /** Configuration directory at the repository root. */
  dir: string;
  /**
   * Where its hook registrations live, or `undefined` when it takes none.
   * A harness with no registry is registered nowhere and deregistered nowhere.
   */
  hookRegistry: string | undefined;
  /**
   * How it spells hook event keys: `canonical` keeps the Claude Code / Codex
   * name, `lowerCamel` lowercases the first letter. A harness that renames one
   * event outright declares it in `eventAliases` instead.
   */
  eventCase: "canonical" | "lowerCamel";
  /** Canonical names of the events this harness does not support at all. */
  unsupportedEvents: readonly string[];
  /** Events it spells neither canonically nor by case, keyed by canonical name. */
  eventAliases: Readonly<Record<string, string>>;
  /**
   * Whether agentsdir projects the source of truth into this harness's
   * directory. `false` means the harness reads `.agents/` (or AGENTS.md)
   * directly and owns no generated file — the explicit notion that replaced
   * the `includes("claude")` guards.
   */
  projectsFiles: boolean;
}

export const HARNESS_SPECS: Record<Harness, HarnessSpec> = {
  claude: {
    dir: ".claude",
    hookRegistry: ".claude/settings.json",
    eventCase: "canonical",
    unsupportedEvents: [],
    eventAliases: {},
    // the only harness with file projections today: CLAUDE.md and
    // .claude/{rules,skills,agents}. Codex and Cursor read AGENTS.md and
    // .agents/ where they stand.
    projectsFiles: true,
  },
  codex: {
    dir: ".codex",
    hookRegistry: ".codex/hooks.json",
    eventCase: "canonical",
    unsupportedEvents: ["Notification"],
    eventAliases: {},
    projectsFiles: false,
  },
  cursor: {
    dir: ".cursor",
    hookRegistry: ".cursor/hooks.json",
    eventCase: "lowerCamel",
    unsupportedEvents: ["PostCompact", "PermissionRequest", "Notification"],
    // Cursor renames this one outright rather than recasing it
    eventAliases: { UserPromptSubmit: "beforeSubmitPrompt" },
    projectsFiles: false,
  },
};

/** The key `harness` uses for `event`, or undefined when it does not support it. */
export function harnessEventKey(
  harness: Harness,
  event: string,
): string | undefined {
  const spec = HARNESS_SPECS[harness];
  if (spec.unsupportedEvents.includes(event)) {
    return undefined;
  }
  const alias = spec.eventAliases[event];
  if (alias !== undefined) {
    return alias;
  }
  return spec.eventCase === "lowerCamel"
    ? event.charAt(0).toLowerCase() + event.slice(1)
    : event;
}

/** Harnesses agentsdir projects files for. */
export const PROJECTING_HARNESSES = HARNESSES.filter(
  (harness) => HARNESS_SPECS[harness].projectsFiles,
);

/**
 * Does this set of enabled harnesses include one agentsdir projects files for?
 *
 * The question the `includes("claude")` guards were really asking. They named
 * the only harness that happens to have projections today; this names the
 * property, so a fourth harness with projections is covered by declaring it
 * and a harness without them never triggers a projection pass.
 */
export function hasFileProjections(enabled: readonly string[]): boolean {
  return PROJECTING_HARNESSES.some((harness) => enabled.includes(harness));
}
