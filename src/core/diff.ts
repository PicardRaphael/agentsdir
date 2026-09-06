/**
 * A unified diff, hand-rolled. `update` has to show the user what upstream
 * changed under a file they edited, and the runtime dependencies are frozen to
 * four packages (`code-conventions.md`): pulling a diff library in for one
 * report is not an option, and shipping "the file differs" instead would make
 * the merge offer unusable.
 */

/** Lines above and below a change, the git default. */
const CONTEXT_LINES = 3;

/**
 * Past this many lines on either side the quadratic LCS below stops being
 * worth its memory, and a wall of diff stops being readable anyway: the report
 * then says the file differs and how, without spelling every line out.
 */
const MAX_DIFF_LINES = 1500;

/**
 * Unified diff from `before` to `after`, headed by `path`. Returns an empty
 * string when the two sides are identical, so a caller can test the diff
 * itself rather than comparing the inputs a second time.
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
): string {
  if (before === after) {
    return "";
  }
  const left = splitLines(before);
  const right = splitLines(after);
  const header = `--- ${path} (local)\n+++ ${path} (agentsdir upstream)`;
  if (left.length > MAX_DIFF_LINES || right.length > MAX_DIFF_LINES) {
    return `${header}\n@@ too large to diff (${left.length} local lines, ${right.length} upstream) @@`;
  }
  const hunks = groupHunks(diffLines(left, right));
  if (hunks.length === 0) {
    return "";
  }
  return [header, ...hunks.map(renderHunk)].join("\n");
}

interface DiffLine {
  kind: " " | "-" | "+";
  text: string;
}

interface Hunk {
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
  lines: DiffLine[];
}

/**
 * A trailing newline is a line terminator, not an empty last line: splitting
 * "a\n" into ["a", ""] would report a spurious change against "a".
 */
function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Longest common subsequence, then the classic backtrack into a line script. */
function diffLines(left: string[], right: string[]): DiffLine[] {
  const rows = left.length;
  const columns = right.length;
  // table[i][j] = length of the LCS of left[i..] and right[j..]
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      const row = table[i] as number[];
      const next = table[i + 1] as number[];
      row[j] =
        left[i] === right[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const script: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (left[i] === right[j]) {
      script.push({ kind: " ", text: left[i] as string });
      i += 1;
      j += 1;
      continue;
    }
    const down = (table[i + 1] as number[])[j] as number;
    const across = (table[i] as number[])[j + 1] as number;
    // deletions before insertions at equal cost: the order git prints
    if (down >= across) {
      script.push({ kind: "-", text: left[i] as string });
      i += 1;
    } else {
      script.push({ kind: "+", text: right[j] as string });
      j += 1;
    }
  }
  for (; i < rows; i += 1) {
    script.push({ kind: "-", text: left[i] as string });
  }
  for (; j < columns; j += 1) {
    script.push({ kind: "+", text: right[j] as string });
  }
  return script;
}

/** The line script cut into hunks, each padded with CONTEXT_LINES of context. */
function groupHunks(script: DiffLine[]): Hunk[] {
  const changed = script
    .map((line, index) => (line.kind === " " ? -1 : index))
    .filter((index) => index !== -1);
  if (changed.length === 0) {
    return [];
  }
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(script.length - 1, index + CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    // ranges that touch or overlap become one hunk, as `diff -u` does
    if (last !== undefined && from <= last[1] + 1) {
      last[1] = Math.max(last[1], to);
    } else {
      ranges.push([from, to]);
    }
  }
  // line numbers are 1-based and count only the side each line belongs to
  const leftNumbers: number[] = [];
  const rightNumbers: number[] = [];
  let leftAt = 0;
  let rightAt = 0;
  for (const line of script) {
    if (line.kind !== "+") {
      leftAt += 1;
    }
    if (line.kind !== "-") {
      rightAt += 1;
    }
    leftNumbers.push(leftAt);
    rightNumbers.push(rightAt);
  }
  return ranges.map(([from, to]) => {
    const lines = script.slice(from, to + 1);
    const leftCount = lines.filter((line) => line.kind !== "+").length;
    const rightCount = lines.filter((line) => line.kind !== "-").length;
    const firstLeft = lines.find((line) => line.kind !== "+");
    const firstRight = lines.find((line) => line.kind !== "-");
    return {
      // an empty side starts at 0, the convention `diff -u` uses for it
      leftStart:
        firstLeft === undefined
          ? 0
          : (leftNumbers[from + lines.indexOf(firstLeft)] as number),
      leftCount,
      rightStart:
        firstRight === undefined
          ? 0
          : (rightNumbers[from + lines.indexOf(firstRight)] as number),
      rightCount,
      lines,
    };
  });
}

function renderHunk(hunk: Hunk): string {
  const header = `@@ -${hunk.leftStart},${hunk.leftCount} +${hunk.rightStart},${hunk.rightCount} @@`;
  return [header, ...hunk.lines.map((line) => `${line.kind}${line.text}`)].join(
    "\n",
  );
}
