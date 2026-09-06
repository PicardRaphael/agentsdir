import { describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import { MANIFEST_SCHEMA } from "../manifest.js";
import { planSchemaMigration, SCHEMA_MIGRATIONS } from "../migrations.js";
import { EXIT_CODES } from "../../exit-codes.js";

/**
 * The table is the feature: `update` walks it, and a step that is data can be
 * audited row by row. These tests hold the walk, not the content of any one
 * step — a future 2 -> 3 must not have to edit them.
 */
describe("31 - the schema migration table", () => {
  it("Given the declared table, When it is read, Then every step advances the schema by exactly one and the chain reaches MANIFEST_SCHEMA", () => {
    for (const step of SCHEMA_MIGRATIONS) {
      expect(step.to).toBe(step.from + 1);
      expect(step.summary).not.toBe("");
    }
    // schema 1 is the first one a manifest may declare (`validateManifest`)
    expect(planSchemaMigration(1).at(-1)?.to ?? 1).toBe(MANIFEST_SCHEMA);
  });

  it("Given a manifest already at the current schema, When the migration is planned, Then the plan is empty", () => {
    expect(planSchemaMigration(MANIFEST_SCHEMA)).toEqual([]);
  });

  it("Given a manifest one schema behind, When the migration is planned, Then the declared step is returned with its scope", () => {
    const steps = planSchemaMigration(MANIFEST_SCHEMA - 1, MANIFEST_SCHEMA);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.from).toBe(MANIFEST_SCHEMA - 1);
    expect(steps[0]?.to).toBe(MANIFEST_SCHEMA);
    // the scope of a step is managed blocks and projections, nothing else:
    // there is no field here through which a user file could be named
    expect(Object.keys(steps[0] ?? {}).sort()).toEqual([
      "blocks",
      "from",
      "projections",
      "summary",
      "to",
    ]);
  });

  it("Given a gap no declared step bridges, When the migration is planned, Then it fails with exit 1 and names the missing step", () => {
    // 2 -> 3 is not declared: the walk must stop rather than skip it
    const error = (() => {
      try {
        planSchemaMigration(1, MANIFEST_SCHEMA + 1);
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT_CODES.driftOrInvariant);
    expect((error as CliError).message).toContain(
      `from manifest schema ${MANIFEST_SCHEMA} to ${MANIFEST_SCHEMA + 1}`,
    );
    expect((error as CliError).message).toContain("Nothing was written");
  });

  it("Given a manifest newer than this CLI, When the migration is planned, Then it is an environment error, not a migration one", () => {
    const error = (() => {
      try {
        planSchemaMigration(MANIFEST_SCHEMA + 1);
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect((error as CliError).exitCode).toBe(EXIT_CODES.environmentOrUsage);
  });
});
