import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseOpenSkillMarkdown,
  readAgentFrontmatter,
  frontmatterBlockLength,
} from "./frontmatter.js";
import { listRuleFiles } from "./rules-index.js";

/**
 * What the installed configuration costs in context, per session.
 *
 * Everything this product installs is paid in the context window at every
 * session, and nothing measured it. The report answers two questions the usage
 * journal cannot: what each element weighs, and *when* it is paid — a total
 * that adds a skill's startup metadata to its body is impressive and false.
 *
 * Sources of truth only (`AGENTS.md`, `.agents/{skills,rules,agents}`): the
 * `.claude/**` projections are the same bytes under another name, and counting
 * both would double every figure.
 */

/**
 * Characters per token, the divisor of the estimate.
 *
 * Calibrated on 2026-09-12 against the o200k_base BPE (gpt-tokenizer 4.0.0) on
 * 33 real Markdown files of this repository — 183 285 characters for 45 435
 * tokens, i.e. 4.03 characters per token, per-file spread 3.69 to 4.52. The
 * divisor is kept at a round 4: it over-estimates the whole corpus by 0.9%,
 * which is the safe direction for a budget. Claude's tokenizer is not public,
 * so no figure derived from this is ever exact — the report prints them all
 * with a `~`. See docs/conventions.md §10.
 */
export const CHARS_PER_TOKEN = 4;

/** Description bound of the Agent Skills spec, in characters. */
export const MAX_DESCRIPTION_CHARS = 1024;

/** Recommended body budget of the Agent Skills spec, in tokens. */
export const MAX_BODY_TOKENS = 5000;

/** When the context window pays for an element. */
export type WhenPaid = "always" | "on-invocation" | "when-relevant";

export type BudgetKind =
  | "agents-md"
  | "skill-metadata"
  | "skill-body"
  | "skill-reference"
  | "agent-metadata"
  | "agent-body"
  | "rule";

export interface BudgetItem {
  /** Repo-relative POSIX path of the file the item comes from. */
  path: string;
  /** What the item is — several items may share one path (metadata vs body). */
  kind: BudgetKind;
  when: WhenPaid;
  /** Exact: UTF-8 byte length. */
  bytes: number;
  /** Exact: line count. */
  lines: number;
  /** Estimate: characters divided by `CHARS_PER_TOKEN`, rounded up. */
  tokens: number;
}

export interface BudgetBound {
  path: string;
  rule: "skill-description-length" | "skill-body-tokens";
  message: string;
}

export interface BudgetTotals {
  items: number;
  bytes: number;
  tokens: number;
}

export interface ContextBudget {
  /** Every measured item, sorted by path then kind — stable across runs. */
  items: BudgetItem[];
  /** Agent Skills spec bounds exceeded; informational, never a failure. */
  bounds: BudgetBound[];
  totals: {
    always: BudgetTotals;
    onInvocation: BudgetTotals;
    whenRelevant: BudgetTotals;
    all: BudgetTotals;
  };
}

/**
 * Measures the whole configuration. Read-only, and absence is a normal answer
 * everywhere: a repository without `AGENTS.md`, without skills or without
 * rules simply has fewer items, never an error — `doctor` must keep diagnosing
 * a repository `init` has never touched.
 */
export async function measureContextBudget(
  root: string,
): Promise<ContextBudget> {
  const items: BudgetItem[] = [];
  const bounds: BudgetBound[] = [];
  await measureAgentsMd(root, items);
  await measureSkills(root, items, bounds);
  await measureRules(root, items);
  await measureSubAgents(root, items);
  items.sort((a, b) => compare(a.path, b.path) || compare(a.kind, b.kind));
  bounds.sort((a, b) => compare(a.path, b.path) || compare(a.rule, b.rule));
  return { items, bounds, totals: totalsOf(items) };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `AGENTS.md` whole, paid at every session. The rules index lives inside it, so
 * it is not a line of its own: counting the block again would bill it twice.
 */
async function measureAgentsMd(
  root: string,
  items: BudgetItem[],
): Promise<void> {
  const source = await readIfPresent(join(root, "AGENTS.md"));
  if (source === undefined) {
    return;
  }
  items.push(measure("AGENTS.md", "agents-md", "always", source));
}

async function measureSkills(
  root: string,
  items: BudgetItem[],
  bounds: BudgetBound[],
): Promise<void> {
  const skillsDir = join(root, ".agents", "skills");
  for (const folder of await listDirectories(skillsDir)) {
    const skillPath = `.agents/skills/${folder}/SKILL.md`;
    const source = await readIfPresent(join(skillsDir, folder, "SKILL.md"));
    if (source === undefined) {
      continue;
    }
    let name: string | undefined;
    let description: string | undefined;
    try {
      const parsed = parseOpenSkillMarkdown(source);
      name = parsed.frontmatter.name;
      description = parsed.frontmatter.description;
    } catch {
      // a malformed frontmatter is `check`'s business; here it only means the
      // startup metadata cannot be isolated, so the whole file counts as body
    }
    if (name !== undefined && description !== undefined) {
      // exactly what the spec says a harness loads at startup for every skill:
      // the two strings, not the catalogue fields around them
      items.push(
        measure(skillPath, "skill-metadata", "always", `${name}${description}`),
      );
      if (countCodePoints(description) > MAX_DESCRIPTION_CHARS) {
        bounds.push({
          path: skillPath,
          rule: "skill-description-length",
          message: `description is ${countCodePoints(description)} characters; the Agent Skills spec caps it at ${MAX_DESCRIPTION_CHARS}, and every session pays it.`,
        });
      }
    }
    const body = source.slice(frontmatterBlockLength(source));
    const bodyItem = measure(skillPath, "skill-body", "on-invocation", body);
    items.push(bodyItem);
    if (bodyItem.tokens > MAX_BODY_TOKENS) {
      bounds.push({
        path: skillPath,
        rule: "skill-body-tokens",
        message: `body is ~${bodyItem.tokens} tokens; the Agent Skills spec recommends staying under ${MAX_BODY_TOKENS} — move the depth into references/, which is paid only when read.`,
      });
    }
    await measureReferences(skillsDir, folder, items);
  }
}

/**
 * `references/` of a skill, one item per file: the spec loads them on demand,
 * which is exactly the point of moving depth there. `scripts/`, `steps/`,
 * `templates/` and `assets/` are excluded — they are executed, rendered or
 * shipped, not read into the window.
 */
async function measureReferences(
  skillsDir: string,
  folder: string,
  items: BudgetItem[],
): Promise<void> {
  const base = join(skillsDir, folder, "references");
  for (const relative of await listFilesDeep(base)) {
    const source = await readIfPresent(join(base, ...relative.split("/")));
    if (source === undefined) {
      continue;
    }
    items.push(
      measure(
        `.agents/skills/${folder}/references/${relative}`,
        "skill-reference",
        "on-invocation",
        source,
      ),
    );
  }
}

/**
 * A rule is paid whole or not at all, and its `paths:` frontmatter is what
 * decides: a scoped rule reaches the window when the session touches a file it
 * covers, an unscoped one has no scope to miss and is loaded at every session.
 * Reading them all as "when relevant" would under-report the always-paid total
 * — the same lie as the over-reporting one, upside down.
 */
async function measureRules(root: string, items: BudgetItem[]): Promise<void> {
  let files: string[];
  try {
    files = await listRuleFiles(root);
  } catch {
    // a linked rules directory: `check` refuses it, the budget just has none
    return;
  }
  for (const file of files) {
    const source = await readIfPresent(join(root, ".agents", "rules", file));
    if (source === undefined) {
      continue;
    }
    items.push(
      measure(
        `.agents/rules/${file}`,
        "rule",
        hasScope(source) ? "when-relevant" : "always",
        source,
      ),
    );
  }
}

/** True when the rule declares a `paths:` scope in its frontmatter. */
function hasScope(source: string): boolean {
  const length = frontmatterBlockLength(source);
  if (length === 0) {
    return false;
  }
  const frontmatter = source.slice(0, length);
  return /^paths:/m.test(frontmatter);
}

/**
 * Sub-agents follow the skills' shape: the delegation list carries `name` and
 * `description` at every session, the body is read when the agent is delegated
 * to.
 */
async function measureSubAgents(
  root: string,
  items: BudgetItem[],
): Promise<void> {
  const dir = join(root, ".agents", "agents");
  for (const file of await listMarkdownFiles(dir)) {
    const path = `.agents/agents/${file}`;
    const source = await readIfPresent(join(dir, file));
    if (source === undefined) {
      continue;
    }
    const table = readAgentFrontmatter(source);
    const name = table?.["name"];
    const description = table?.["description"];
    if (typeof name === "string" && typeof description === "string") {
      items.push(
        measure(path, "agent-metadata", "always", `${name}${description}`),
      );
    }
    items.push(
      measure(
        path,
        "agent-body",
        "on-invocation",
        source.slice(frontmatterBlockLength(source)),
      ),
    );
  }
}

function measure(
  path: string,
  kind: BudgetKind,
  when: WhenPaid,
  text: string,
): BudgetItem {
  return {
    path,
    kind,
    when,
    bytes: Buffer.byteLength(text, "utf8"),
    lines: countLines(text),
    tokens: Math.ceil(countCodePoints(text) / CHARS_PER_TOKEN),
  };
}

function totalsOf(items: BudgetItem[]): ContextBudget["totals"] {
  const bucket = (when: WhenPaid): BudgetTotals =>
    sum(items.filter((item) => item.when === when));
  return {
    always: bucket("always"),
    onInvocation: bucket("on-invocation"),
    whenRelevant: bucket("when-relevant"),
    all: sum(items),
  };
}

function sum(items: BudgetItem[]): BudgetTotals {
  return {
    items: items.length,
    bytes: items.reduce((total, item) => total + item.bytes, 0),
    tokens: items.reduce((total, item) => total + item.tokens, 0),
  };
}

/**
 * Unicode code points, counted without materialising an array: the calibration
 * was made on code points, and a 60-skill repository would otherwise allocate
 * one array per measured file for nothing.
 */
function countCodePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      }
    }
    count += 1;
  }
  return count;
}

/** Lines of a text: a trailing newline does not open one more. */
function countLines(text: string): number {
  if (text === "") {
    return 0;
  }
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Sub-directories of `dir`, sorted, symlinks excluded — the harness follows a
 * linked skill folder and loads what it points at, which `check` refuses
 * (invariant 18) and which the budget must not bill to this repository.
 */
async function listDirectories(dir: string): Promise<string[]> {
  const entries = await readdirIfPresent(dir);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort(compare);
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdirIfPresent(dir);
  return entries
    .filter(
      (entry) =>
        entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md"),
    )
    .map((entry) => entry.name)
    .sort(compare);
}

/** POSIX-relative paths of every regular file under `dir`, links excluded. */
async function listFilesDeep(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdirIfPresent(dir)) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await listFilesDeep(join(dir, entry.name), relative)));
    } else if (entry.isFile()) {
      found.push(relative);
    }
  }
  return found.sort(compare);
}

async function readdirIfPresent(
  dir: string,
): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
