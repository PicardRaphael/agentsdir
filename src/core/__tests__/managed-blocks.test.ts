import { describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import { renderBlock, upsertBlock } from "../managed-blocks.js";

describe("04 - managed blocks", () => {
  it("Given a file without the block, When upsertBlock runs, Then the block is appended at the end and the rest is preserved byte for byte", () => {
    const source = "# My file\n\ncustom content\n";
    const result = upsertBlock(source, "rules-index", "- a rule", "html");
    expect(result.startsWith(source)).toBe(true);
    expect(result).toBe(
      "# My file\n\ncustom content\n\n<!-- agentsdir:begin rules-index -->\n- a rule\n<!-- agentsdir:end rules-index -->\n",
    );
  });

  it("Given a file without a trailing newline, When upsertBlock appends, Then a separator is inserted and the original bytes stay intact", () => {
    const source = "last line without newline";
    const result = upsertBlock(source, "ignore", "/.agents/memory/", "hash");
    expect(result).toBe(
      "last line without newline\n\n# agentsdir:begin ignore\n/.agents/memory/\n# agentsdir:end ignore\n",
    );
  });

  it("Given an empty file, When upsertBlock runs, Then the file becomes exactly the block plus a final newline", () => {
    const result = upsertBlock("", "ignore", "/.agents/memory/", "hash");
    expect(result).toBe(
      "# agentsdir:begin ignore\n/.agents/memory/\n# agentsdir:end ignore\n",
    );
  });

  it("Given a block present in the middle of a file, When upsertBlock replaces it, Then everything outside the markers is preserved byte for byte", () => {
    const before = "intro\n\n";
    const after = "\n\noutro\n";
    const source = `${before}${renderBlock("rules-index", "old", "html")}${after}`;
    const result = upsertBlock(source, "rules-index", "new content", "html");
    expect(result).toBe(
      `${before}${renderBlock("rules-index", "new content", "html")}${after}`,
    );
  });

  it("Given a begin marker without its end marker, When upsertBlock runs, Then it fails with the drift exit code 1", () => {
    const source = "intro\n<!-- agentsdir:begin rules-index -->\nbroken\n";
    let thrown: unknown;
    try {
      upsertBlock(source, "rules-index", "content", "html");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(1);
  });
});
