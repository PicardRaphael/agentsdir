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
