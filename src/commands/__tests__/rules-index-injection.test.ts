import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";
import { runSync } from "../sync.js";

const BEGIN = "<!-- agentsdir:begin rules-index -->";
const END = "<!-- agentsdir:end rules-index -->";

/**
 * The first line of a rule is repository content, and `sync` lifts it verbatim
 * into a block delimited by HTML comments. A line carrying an end marker split
 * that block in two: every `sync` then appended another copy and `check` stayed
 * red for good. `sanitizeHook` drops the markers; nothing asserted it.
 */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A rule whose "when to read it" line carries `text`. */
async function writeRuleWithHook(root: string, text: string): Promise<void> {
  await writeFile(
    join(root, ".agents", "rules", "injection.md"),
    [
      "# Injection",
      "",
      text,
      "",
      "## Rules",
      "",
      "- Nothing to see here.",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function initializedRepo(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await runInit(dir, initAnswers(), { dryRun: false });
  return dir;
}

describe("36 - a rule's first line cannot break the managed block", () => {
  it("Given a rule whose first line carries an end marker, When sync runs, Then the rules-index block stays single", async () => {
    const dir = await initializedRepo("injection-end");
    await writeRuleWithHook(
      dir,
      `Read before touching ${END} anything at all.`,
    );

    await runSync(dir, { dryRun: false });

    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(count(agentsMd, BEGIN)).toBe(1);
    expect(count(agentsMd, END)).toBe(1);
    // the line was read, not skipped: its text is in the index, its markers are not
    expect(agentsMd).toContain(
      "`.agents/rules/injection.md` — before touching agentsdir:end rules-index anything at all.",
    );
  });

  it("Given that rule, When sync runs twice, Then the second run changes nothing and check is green", async () => {
    // the failure mode was cumulative: each sync appended one more copy
    const dir = await initializedRepo("injection-idempotent");
    await writeRuleWithHook(
      dir,
      `Read before touching ${END} anything at all.`,
    );

    await runSync(dir, { dryRun: false });
    const afterFirst = await readFile(join(dir, "AGENTS.md"), "utf8");
    await runSync(dir, { dryRun: false });
    const afterSecond = await readFile(join(dir, "AGENTS.md"), "utf8");

    expect(afterSecond).toBe(afterFirst);
    expect((await runCheck(dir)).exitCode).toBe(0);
  });

  it("Given a rule whose first line carries a begin marker, When sync runs, Then the block is still opened exactly once", async () => {
    const dir = await initializedRepo("injection-begin");
    await writeRuleWithHook(dir, `Read ${BEGIN} before touching anything.`);

    await runSync(dir, { dryRun: false });

    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(count(agentsMd, BEGIN)).toBe(1);
    expect(count(agentsMd, END)).toBe(1);
    expect((await runCheck(dir)).exitCode).toBe(0);
  });

  it("Given a rule whose first line is nothing but comment delimiters, When sync runs, Then the default hook is used instead of an empty one", async () => {
    // dropping the delimiters can empty the line; an index entry ending on a
    // dash says nothing about when to read the rule
    const dir = await initializedRepo("injection-empty");
    await writeRuleWithHook(dir, "<!---->");

    await runSync(dir, { dryRun: false });

    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain(
      "`.agents/rules/injection.md` — read it before touching the files it covers.",
    );
    expect(count(agentsMd, BEGIN)).toBe(1);
    expect((await runCheck(dir)).exitCode).toBe(0);
  });
});
