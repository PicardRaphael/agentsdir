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

/** `.github/workflows/agents-check.yml` — CI drift check. */
export function renderAgentsCheckWorkflow(): string {
  return [
    "name: agents-check",
    "",
    "on:",
    "  push:",
    "  pull_request:",
    "",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 20",
    "      - run: npx agentsdir check",
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
