/**
 * Exit codes shared by every command — the stable CI contract.
 * Never call process.exit() with a literal anywhere else.
 */
export const EXIT_CODES = {
  /** Everything is in order. */
  ok: 0,
  /** Drift detected or an invariant is violated. */
  driftOrInvariant: 1,
  /** Environment or usage error. */
  environmentOrUsage: 2,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
