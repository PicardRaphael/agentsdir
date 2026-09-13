/**
 * Where the `usage` pack writes what it observes. The constant lives in
 * `core/` rather than in the pack because two layers need it and the layering
 * contract only allows one direction: `check` fails when git tracks the
 * journal (`validate.ts`), and the pack renders the collector that writes
 * there (`packs/usage.ts`). A second spelling of this path in either place
 * would be a guard watching a directory nobody writes to.
 *
 * Under `.agents/output/`, which the managed `.gitignore` block excludes —
 * see `docs/conventions.md` §8 for the state directories and §9 for the
 * journal format.
 */
export const USAGE_JOURNAL_DIR = ".agents/output/usage";

/**
 * Days a journal file survives. Shared by the two stages of the pack: the
 * collectors prune past it, and the review states it as a limit of what it
 * could observe — a conclusion drawn on a 30-day window is not a conclusion
 * about the year.
 */
export const USAGE_RETENTION_DAYS = 30;
