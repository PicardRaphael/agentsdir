import { EXIT_CODES } from "../exit-codes.js";
import { CliError } from "./errors.js";

/**
 * Managed blocks are the only regions the CLI ever writes inside a file it
 * shares with the user. Everything outside the markers is preserved byte for
 * byte.
 */
export type CommentStyle = "html" | "hash";

function markers(
  id: string,
  style: CommentStyle,
): { begin: string; end: string } {
  return style === "html"
    ? {
        begin: `<!-- agentsdir:begin ${id} -->`,
        end: `<!-- agentsdir:end ${id} -->`,
      }
    : { begin: `# agentsdir:begin ${id}`, end: `# agentsdir:end ${id}` };
}

/** Renders a complete managed block (markers included, no trailing newline). */
export function renderBlock(
  id: string,
  content: string,
  style: CommentStyle,
): string {
  const { begin, end } = markers(id, style);
  return `${begin}\n${content.replace(/\n+$/, "")}\n${end}`;
}

/**
 * Replaces the block `id` in `source`, or appends it at the end of the file
 * when absent. The rest of the file is preserved byte for byte; output always
 * uses LF and ends with a newline after an appended block.
 */
export function upsertBlock(
  source: string,
  id: string,
  content: string,
  style: CommentStyle,
): string {
  const block = renderBlock(id, content, style);
  const { begin, end } = markers(id, style);
  const beginIndex = source.indexOf(begin);
  if (beginIndex !== -1) {
    const endIndex = source.indexOf(end, beginIndex);
    if (endIndex === -1) {
      throw new CliError(
        `Managed block "${id}" has a begin marker but no end marker. Fix or remove the broken markers, then retry.`,
        EXIT_CODES.driftOrInvariant,
      );
    }
    return (
      source.slice(0, beginIndex) + block + source.slice(endIndex + end.length)
    );
  }
  if (source.length === 0) {
    return `${block}\n`;
  }
  const separator = source.endsWith("\n\n")
    ? ""
    : source.endsWith("\n")
      ? "\n"
      : "\n\n";
  return `${source}${separator}${block}\n`;
}
