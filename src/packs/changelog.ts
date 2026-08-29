import type { PackContent } from "./index.js";

/**
 * Pack `changelog`: the changelog rule and a bootstrapped `CHANGELOG.md` at
 * the repo root. An existing CHANGELOG.md is kept as is — bootstrapping never
 * overwrites a real changelog.
 */
export function changelogPack(): PackContent {
  return {
    name: "changelog",
    files: [
      { path: ".agents/rules/changelog.md", content: renderRule() },
      { path: "CHANGELOG.md", content: renderChangelogSeed() },
    ],
    skills: [],
    rules: ["changelog.md"],
    keepExisting: ["CHANGELOG.md"],
  };
}

function renderRule(): string {
  return [
    "# Changelog",
    "",
    "Read before committing any user-visible change.",
    "",
    "## Rules",
    "",
    "- ALWAYS add an entry under the Unreleased section of CHANGELOG.md in the",
    "  same commit as the change it describes.",
    "- Write entries for humans: what changed and why it matters — not the",
    "  commit subject line.",
    "- Classify each entry under Added, Changed, Fixed or Removed.",
    "- NEVER rewrite a released section — a correction gets a new entry.",
    "",
    "## Examples",
    "",
    "GOOD:",
    "",
    "```",
    "### Fixed",
    "",
    "- Retries no longer duplicate the payment when the gateway times out.",
    "```",
    "",
    "BAD:",
    "",
    "```",
    "### Fixed",
    "",
    "- fix retry bug (#412)",
    "```",
    "",
  ].join("\n");
}

function renderChangelogSeed(): string {
  return [
    "# Changelog",
    "",
    "All notable changes to this project are documented in this file. Entries",
    "are grouped under Added / Changed / Fixed / Removed, newest release first;",
    "unreleased work accumulates under Unreleased.",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- Changelog bootstrapped by agentsdir (`pack add changelog`).",
    "",
  ].join("\n");
}
