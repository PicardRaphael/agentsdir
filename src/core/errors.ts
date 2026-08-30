import { EXIT_CODES, type ExitCode } from "../exit-codes.js";

/**
 * Error whose message is meant for the user. Commands print it and exit with
 * the carried code instead of surfacing a stack trace.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(
    message: string,
    exitCode: ExitCode = EXIT_CODES.environmentOrUsage,
  ) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * A filesystem failure the user can act on, turned into the message and the
 * exit code the contract promises (`docs/commandes.md`: `2` for an environment
 * error). Left alone, an ENOTDIR or an EACCES surfaced as a raw stack trace,
 * exited `1` — the code a CI script reads as drift — and printed nothing on
 * stdout under `--json`.
 *
 * Only errors carrying an errno `code` are converted; `undefined` means "not
 * mine". A TypeError is a bug in this CLI, not something the user can fix, and
 * keeps its stack trace.
 */
export function asUserFacingError(error: unknown): CliError | undefined {
  if (error instanceof CliError) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== "string" || !(error instanceof Error)) {
    return undefined;
  }
  return new CliError(
    `${error.message} — fix the path or its permissions, then run the command again.`,
    EXIT_CODES.environmentOrUsage,
  );
}
