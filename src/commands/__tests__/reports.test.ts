import { describe, expect, it } from "vitest";
import type { Violation } from "../../core/validate.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { renderSyncReport, type SyncChange, type SyncResult } from "../sync.js";
import {
  mergeChanges,
  renderUpdateReport,
  type UpdateConflict,
  type UpdateResult,
} from "../update.js";

/**
 * The two report renderers are the only text most users ever read from this
 * CLI, and nothing asserted a line of it: both were reachable only through a
 * full command run, which asserts exit codes and files on disk, never wording.
 * A renderer that miscounts, or that drops the line saying nothing was
 * overwritten, is a lie told in the calmest possible voice.
 *
 * They are pure functions of their result, so they are exercised here on
 * hand-built results — every branch, including the ones a real repository
 * almost never produces.
 */

function change(path: string, action: SyncChange["action"]): SyncChange {
  return { path, action };
}

function syncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    changes: [],
    violations: [],
    exitCode: EXIT_CODES.ok,
    mode: "copy",
    ...overrides,
  };
}

function updateResult(overrides: Partial<UpdateResult> = {}): UpdateResult {
  return {
    changes: [],
    migrations: [],
    preserved: [],
    conflicts: [],
    violations: [],
    exitCode: EXIT_CODES.ok,
    mode: "copy",
    ...overrides,
  };
}

function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    path: ".agents/rules/a.md",
    rule: "rule-frontmatter",
    message: "missing description.",
    severity: "error",
    ...overrides,
  };
}

function conflict(overrides: Partial<UpdateConflict> = {}): UpdateConflict {
  return {
    path: ".agents/skills/demo",
    diff: "--- local\n+++ shipped\n-old\n+new",
    resolution: "undecided",
    ...overrides,
  };
}

describe("sync - the report a user reads", () => {
  it("Given source invariants that blocked the run, When the report is rendered, Then it lists them and says nothing was written", () => {
    const report = renderSyncReport(
      syncResult({
        violations: [violation(), violation({ path: ".agents/rules/b.md" })],
        exitCode: EXIT_CODES.driftOrInvariant,
      }),
      { dryRun: false },
    );

    expect(report).toContain(
      "drift  .agents/rules/a.md · rule-frontmatter · missing description.",
    );
    expect(report).toContain("drift  .agents/rules/b.md");
    expect(report).toContain(
      "Sync aborted — fix the source invariants above; nothing was written.",
    );
    // an aborted run has no plan and no counts: printing "0 created" next to a
    // refusal reads as a successful run that simply had nothing to do
    expect(report).not.toContain("Done:");
    expect(report).not.toContain("Plan:");
  });

  it("Given a real run, When the report is rendered, Then every action is counted under its own name", () => {
    const report = renderSyncReport(
      syncResult({
        changes: [
          change("CLAUDE.md", "created"),
          change(".claude/rules/a.md", "updated"),
          change(".claude/rules/b.md", "updated"),
          change(".claude/rules/gone.md", "removed"),
          change(".agents.toml", "ok"),
        ],
      }),
      { dryRun: false },
    );

    expect(report).toContain("Synced:");
    expect(report).toContain(
      "Done: 1 created, 2 updated, 1 removed, 1 already up to date.",
    );
    expect(report).not.toContain("Dry run");
  });

  it("Given a dry run, When the report is rendered, Then it announces a plan in the future tense and no write", () => {
    const report = renderSyncReport(
      syncResult({ changes: [change("CLAUDE.md", "created")] }),
      { dryRun: true },
    );

    expect(report).toContain("Dry run — nothing was written. Full write plan:");
    expect(report).toContain(
      "Plan: 1 to create, 0 to update, 0 to remove, 0 already up to date.",
    );
    expect(report).not.toContain("Synced:");
    expect(report).not.toContain("Done:");
  });

  it("Given the four actions, When their lines are rendered, Then the paths line up in one column", () => {
    // "ok" is two letters where the others are seven: the padding is what keeps
    // the path column readable, and it is the kind of thing a refactor drops
    const report = renderSyncReport(
      syncResult({
        changes: [
          change("a", "created"),
          change("b", "updated"),
          change("c", "removed"),
          change("d", "ok"),
        ],
      }),
      { dryRun: false },
    );

    const pathColumns = report
      .split("\n")
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.lastIndexOf(line.trim().slice(-1)));
    expect(new Set(pathColumns).size).toBe(1);
    expect(report).toContain("  ok       d");
  });
});

describe("update - the report a user reads", () => {
  it("Given invariants that blocked the run before any write, When the report is rendered, Then it aborts without a plan", () => {
    const report = renderUpdateReport(
      updateResult({
        violations: [violation()],
        exitCode: EXIT_CODES.driftOrInvariant,
      }),
      { dryRun: false },
    );

    expect(report).toContain("drift  .agents/rules/a.md · rule-frontmatter");
    expect(report).toContain(
      "Update aborted — fix the invariants above; nothing was written.",
    );
    expect(report).not.toContain("Done:");
  });

  it("Given error violations and changes that were still written, When the report is rendered, Then it reports the run instead of pretending nothing happened", () => {
    // the subtle branch: a violation alone does not abort — the abort is a
    // violation *and* an empty plan. A run that wrote must say what it wrote.
    const report = renderUpdateReport(
      updateResult({
        violations: [violation()],
        changes: [change("AGENTS.md", "updated")],
      }),
      { dryRun: false },
    );

    expect(report).not.toContain("Update aborted");
    expect(report).toContain("Updated:");
    expect(report).toContain(
      "Done: 0 created, 1 updated, 0 removed, 0 already up to date.",
    );
  });

  it("Given a manifest already at the current schema, When the report is rendered, Then it says so rather than printing an empty migration block", () => {
    const report = renderUpdateReport(updateResult(), { dryRun: false });

    expect(report).toContain(
      "Manifest schema is already current — no structural migration.",
    );
    expect(report).not.toContain("Schema migration:");
  });

  it("Given schema steps to walk, When the report is rendered, Then each step shows where it goes and what it does", () => {
    const report = renderUpdateReport(
      updateResult({
        migrations: [
          {
            from: 1,
            to: 2,
            summary: "adds the usage section.",
            blocks: [],
            projections: false,
          },
          {
            from: 2,
            to: 3,
            summary: "renames the hooks block.",
            blocks: [],
            projections: true,
          },
        ],
      }),
      { dryRun: false },
    );

    expect(report).toContain("Schema migration:");
    expect(report).toContain("  1 -> 2  adds the usage section.");
    expect(report).toContain("  2 -> 3  renames the hooks block.");
  });

  it("Given files modified locally that upstream did not touch, When the report is rendered, Then they are listed as kept, not as pending", () => {
    const report = renderUpdateReport(
      updateResult({ preserved: [".agents/rules/mine.md", "AGENTS.md"] }),
      { dryRun: false },
    );

    expect(report).toContain("Kept (modified locally, no merge pending):");
    expect(report).toContain("  .agents/rules/mine.md");
    expect(report).toContain("  AGENTS.md");
    expect(report).not.toContain("Merge needed");
  });

  it("Given a conflict nobody decided, When the report is rendered, Then it shows the diff and states that nothing was overwritten", () => {
    const report = renderUpdateReport(
      updateResult({ conflicts: [conflict()] }),
      {
        dryRun: false,
      },
    );

    expect(report).toContain(
      "Merge needed — .agents/skills/demo was modified locally and agentsdir ships a new version:",
    );
    expect(report).toContain("+++ shipped");
    expect(report).toContain(
      "Nothing was overwritten. Run `agentsdir update` in a terminal to decide, or apply the diff by hand.",
    );
  });

  it("Given conflicts the user already settled, When the report is rendered, Then no merge is announced", () => {
    const report = renderUpdateReport(
      updateResult({
        conflicts: [
          conflict({ resolution: "kept" }),
          conflict({ path: "other", resolution: "replaced" }),
        ],
      }),
      { dryRun: false },
    );

    expect(report).not.toContain("Merge needed");
    expect(report).not.toContain("Nothing was overwritten");
  });

  it("Given a dry run, When the report is rendered, Then it announces a plan and never claims an update", () => {
    const report = renderUpdateReport(
      updateResult({
        changes: [change("AGENTS.md", "updated"), change("CLAUDE.md", "ok")],
      }),
      { dryRun: true },
    );

    expect(report).toContain("Dry run — nothing was written. Full plan:");
    expect(report).toContain(
      "Plan: 0 to create, 1 to update, 0 to remove, 1 already up to date.",
    );
    expect(report).not.toContain("Updated:");
  });
});

describe("update - merging sync's plan into its own", () => {
  it("Given a file this command wrote whose projection was already in step, When the plans are merged, Then it stays an update", () => {
    const merged = mergeChanges(
      [change("AGENTS.md", "updated")],
      [change("AGENTS.md", "ok")],
    );

    expect(merged).toEqual([change("AGENTS.md", "updated")]);
  });

  it("Given a file sync had to write that this command left alone, When the plans are merged, Then the real action wins over the ok", () => {
    const merged = mergeChanges(
      [change("CLAUDE.md", "ok")],
      [change("CLAUDE.md", "updated")],
    );

    expect(merged).toEqual([change("CLAUDE.md", "updated")]);
  });

  it("Given both plans acting on the same file, When they are merged, Then this command's action is the one reported", () => {
    const merged = mergeChanges(
      [change("CLAUDE.md", "created")],
      [change("CLAUDE.md", "updated")],
    );

    expect(merged).toEqual([change("CLAUDE.md", "created")]);
  });

  it("Given removals among the changes, When the plans are merged, Then they come first and each rank is sorted by path", () => {
    // a removal is the line a user must see before deciding anything, so it
    // leads the report whatever its path would sort to
    const merged = mergeChanges(
      [change("z.md", "created"), change("a.md", "updated")],
      [change("m.md", "removed"), change("b.md", "removed")],
    );

    expect(merged.map((entry) => entry.path)).toEqual([
      "b.md",
      "m.md",
      "a.md",
      "z.md",
    ]);
  });
});
