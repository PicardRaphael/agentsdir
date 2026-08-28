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
