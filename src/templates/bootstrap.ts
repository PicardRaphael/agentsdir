import { CLI_VERSION } from "../version.js";

/** `.agents/tasks/README.md` — explains the task file format. */
export function renderTasksReadme(): string {
  return [
    "# Task backlog",
    "",
    "One file per task, self-sufficient, deleted on delivery.",
    "",
    "## Format",
    "",
    "```markdown",
    "# NN — Task title",
    "",
    "## Problem",
    "",
    "What is wrong or missing, in the repo's terms.",
    "",
    "## Acceptance criteria",
    "",
    "- Observable, testable statements — the task is done when they all hold.",
    "",
    "## Verification",
    "",
    "The exact commands proving the criteria, executed before delivery.",
    "",
    "## Out of scope",
    "",
    "What this task deliberately does not cover.",
    "```",
    "",
  ].join("\n");
}

/** `.agents/memory.template/MEMORY.md` — versioned model for the local memory. */
export function renderMemoryTemplate(): string {
  return [
    "# Memory index",
    "",
    "Copy this directory to `.agents/memory/` (kept out of git) on a fresh clone.",
    "One line per memory file: `- [Title](file.md) — when it matters.`",
    "",
  ].join("\n");
}

/**
 * `.github/workflows/agents-check.yml` — CI drift check.
 *
 * The version is pinned and the token is read-only on purpose: this workflow
 * runs on every push of someone else's repository. An unpinned `npx agentsdir`
 * would execute whatever the registry serves that day, with the repository
 * checked out and the default `GITHUB_TOKEN` in scope.
 */
export function renderAgentsCheckWorkflow(): string {
  return [
    "name: agents-check",
    "",
    "on:",
    "  push:",
    "  pull_request:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v5",
    "      - uses: actions/setup-node@v5",
    "        with:",
    "          node-version: 24",
    `      - run: npx --yes agentsdir@${CLI_VERSION} check`,
    "",
  ].join("\n");
}

/** `.gitattributes` written only when the repo has none. */
export function renderGitattributes(): string {
  return [
    "# Normalized line endings: scripts and fingerprinted files must be identical",
    "# on every machine.",
    "* text=auto eol=lf",
    "",
  ].join("\n");
}

/** Content of the `ignore` managed block for `.gitignore` (markers excluded). */
export function renderGitignoreContent(): string {
  return ["/.agents/memory/", "/.agents/output/"].join("\n");
}
