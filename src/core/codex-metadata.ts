import lucide from "../icons/lucide.json" with { type: "json" };
import { EXIT_CODES } from "../exit-codes.js";
import { CliError } from "./errors.js";
import type { SkillFrontmatter } from "./frontmatter.js";

const ICONS: Record<string, string> = lucide.icons;

/** Names of the embedded icon set, sorted for deterministic output. */
export const ICON_NAMES: readonly string[] = Object.keys(ICONS).sort();

/**
 * Renders `agents/openai.yaml` in the official Codex format. Hand-rendered
 * (never through a YAML serializer) so the output is deterministic byte for
 * byte — fingerprints and `check` depend on it.
 */
export function renderOpenAiYaml(frontmatter: SkillFrontmatter): string {
  return [
    "interface:",
    `  display_name: ${quote(frontmatter.displayName)}`,
    `  short_description: ${quote(frontmatter.shortDescription)}`,
    `  icon_small: "./assets/icon.svg"`,
    `  icon_large: "./assets/icon.svg"`,
    `  brand_color: ${quote(frontmatter.color)}`,
    `  default_prompt: ${quote(frontmatter.defaultPrompt)}`,
    "",
    "policy:",
    `  allow_implicit_invocation: ${frontmatter.implicit}`,
    "",
  ].join("\n");
}

/**
 * Renders `assets/icon.svg`: the embedded 24x24 lucide strokes in white,
 * width 1.8, centered on a rounded rectangle filled with the skill color,
 * exported at 128x128.
 */
export function renderSkillIcon(frontmatter: SkillFrontmatter): string {
  const strokes = ICONS[frontmatter.icon];
  if (strokes === undefined) {
    throw new CliError(
      `Unknown icon "${frontmatter.icon}" — the embedded set does not contain it. Did you mean "${closestIconName(frontmatter.icon)}"?`,
      EXIT_CODES.driftOrInvariant,
    );
  }
  const label = escapeXml(frontmatter.displayName);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="${label}">`,
    `  <title>${label}</title>`,
    `  <rect width="128" height="128" rx="5" fill="${frontmatter.color}"/>`,
    `  <g transform="translate(28 28) scale(3)" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${strokes}</g>`,
    "</svg>",
    "",
  ].join("\n");
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function closestIconName(input: string): string {
  let best = ICON_NAMES[0] ?? "";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of ICON_NAMES) {
    const distance = levenshtein(input, name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distances = Array.from({ length: rows }, (_, row) => {
    const line = new Array<number>(cols).fill(0);
    line[0] = row;
    return line;
  });
  for (let col = 0; col < cols; col += 1) {
    (distances[0] as number[])[col] = col;
  }
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      const above = (distances[row - 1] as number[])[col] as number;
      const left = (distances[row] as number[])[col - 1] as number;
      const diagonal = (distances[row - 1] as number[])[col - 1] as number;
      (distances[row] as number[])[col] = Math.min(
        above + 1,
        left + 1,
        diagonal + cost,
      );
    }
  }
  return (distances[rows - 1] as number[])[cols - 1] as number;
}
