import { EXIT_CODES } from "../exit-codes.js";
import { CliError } from "./errors.js";
import { MANIFEST_SCHEMA } from "./manifest.js";
import { RULES_INDEX_BLOCK } from "./rules-index.js";

/**
 * Schema transformations, declared as data — the motif `PACK_REGISTRY` already
 * established here. A table of steps can be read, tested and audited one row at
 * a time; a cascade of `if` on the version cannot, and is where a migration
 * silently stops being applied.
 *
 * A step declares its **scope**: the managed blocks it rebuilds and whether the
 * projections are rebuilt with them. Nothing else is in reach — the content
 * written by the user (`SKILL.md`, rules, the body of `AGENTS.md`) is outside
 * every step by construction, because no step can name it.
 */
export interface SchemaMigration {
  /** Schema this step starts from. */
  from: number;
  /** Schema it leaves behind — always `from + 1`, one step at a time. */
  to: number;
  /** One line, printed in the plan the user reads before anything is written. */
  summary: string;
  /** Managed block ids this step regenerates from the source of truth. */
  blocks: readonly string[];
  /** Whether every projection is rebuilt as part of this step. */
  projections: boolean;
}

/**
 * The declared steps, in order.
 *
 * 1 → 2 is the first one, and it reshapes nothing: schema 1 was never released
 * (`CHANGELOG.md`: 1.0.0 is built and unpublished), so no repository in the
 * world holds a structure to convert. It is declared all the same rather than
 * left for later, because a migration framework whose table is empty is a
 * framework nobody has ever run — the row exercises the walk, the scope and the
 * closing `sync` on a real repository.
 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    from: 1,
    to: 2,
    summary:
      "rules index and projections rebuilt from the source of truth (no structural change: schema 1 was never released)",
    blocks: [RULES_INDEX_BLOCK],
    projections: true,
  },
];

/**
 * The steps to walk from `from` up to `to`, in order; empty when the manifest
 * is already at `to`.
 *
 * A gap with no declared step is exit `1`, not a silent skip: an installation
 * whose schema the CLI cannot bridge needs a human, and `update` says so
 * before it writes rather than after.
 */
export function planSchemaMigration(
  from: number,
  to: number = MANIFEST_SCHEMA,
): SchemaMigration[] {
  if (from > to) {
    throw new CliError(
      `Manifest schema ${from} is newer than this CLI supports (schema ${to}). Upgrade with \`npx agentsdir@latest\`.`,
      EXIT_CODES.environmentOrUsage,
    );
  }
  const steps: SchemaMigration[] = [];
  for (let version = from; version < to; version += 1) {
    const step = SCHEMA_MIGRATIONS.find(
      (candidate) => candidate.from === version,
    );
    if (step === undefined) {
      throw new CliError(
        `No declared transformation from manifest schema ${version} to ${version + 1}. Nothing was written — this installation cannot be migrated automatically; open an issue with your \`.agents.toml\`.`,
        EXIT_CODES.driftOrInvariant,
      );
    }
    steps.push(step);
  }
  return steps;
}
