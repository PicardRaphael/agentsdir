import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../diff.js";

/**
 * The diff is what makes the merge offer of `update` usable: a report saying
 * "this file differs" leaves the user to find the difference themselves, which
 * is the moment they take the upstream version blind or ignore the warning.
 */
describe("31 - the upstream diff", () => {
  it("Given two identical texts, When they are diffed, Then the diff is empty", () => {
    expect(unifiedDiff("a.md", "same\n", "same\n")).toBe("");
  });

  it("Given a trailing newline on one side only, When they are diffed, Then no spurious change is reported", () => {
    // "a\n".split("\n") is ["a", ""]: the empty tail is a terminator, not a line
    expect(unifiedDiff("a.md", "one\ntwo\n", "one\ntwo")).toBe("");
  });

  it("Given one changed line in a long file, When it is diffed, Then a single hunk carries it with three lines of context", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
    const after = before.replace("e", "E");

    const diff = unifiedDiff(".agents/rules/x.md", before, after);

    expect(diff.split("\n")[0]).toBe("--- .agents/rules/x.md (local)");
    expect(diff.split("\n")[1]).toBe(
      "+++ .agents/rules/x.md (agentsdir upstream)",
    );
    expect(diff).toContain("@@ -2,7 +2,7 @@");
    expect(diff).toContain("-e");
    expect(diff).toContain("+E");
    // b, c, d before and f, g, h after — a is out of context and never printed
    expect(diff).not.toContain("\n a\n");
    expect(diff.split("\n").filter((line) => line.startsWith("-"))).toEqual([
      "--- .agents/rules/x.md (local)",
      "-e",
    ]);
  });

  it("Given two distant changes, When they are diffed, Then each gets its own hunk", () => {
    const before = Array.from({ length: 30 }, (_, index) => `l${index}`).join(
      "\n",
    );
    const after = before.replace("l1\n", "L1\n").replace("l25", "L25");

    const diff = unifiedDiff("x", before, after);

    expect(
      diff.split("\n").filter((line) => line.startsWith("@@")),
    ).toHaveLength(2);
  });

  it("Given a file past the diff bound, When it is diffed, Then the report says so instead of printing thousands of lines", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `l${i}`).join("\n");

    const diff = unifiedDiff("big.md", before, `${before}\nextra`);

    expect(diff).toContain("too large to diff");
    expect(diff.split("\n")).toHaveLength(3);
  });

  it("Given content added to an empty file, When it is diffed, Then the local side starts at 0 as `diff -u` writes it", () => {
    expect(unifiedDiff("x", "", "new\n")).toContain("@@ -0,0 +1,1 @@");
  });
});
