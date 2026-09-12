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
