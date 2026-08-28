export interface RuleCommands {
  test?: string;
  lint?: string;
}

/** Generic rule: how to execute tasks from `.agents/tasks/`. */
export function renderTasksRule(commands: RuleCommands): string {
  const checks =
    commands.test !== undefined || commands.lint !== undefined
      ? `- Run the project's checks before delivering: ${[
          commands.test,
          commands.lint,
        ]
          .filter(
            (command): command is string =>
              command !== undefined && command !== "",
          )
          .map((command) => `\`${command}\``)
          .join(" then ")}.`
      : "- Run the project's test and lint commands before delivering.";
  return [
    "# Task execution",
    "",
    "Read before taking any task from `.agents/tasks/`.",
    "",
    "## Rules",
    "",
    "- Take tasks in the order given by the plan (`.agents/plan/`), unless a task",
    "  states its own dependencies.",
    "- Meet the acceptance criteria exactly — no scope creep, nothing skipped.",
    "- Execute the task's Verification section and paste its output before calling",
    "  the task done.",
    checks,
    "- Delete the task file once delivered — a resolved task file left behind reads",
    "  as open work.",
    "",
  ].join("\n");
}

/** Generic rule: how to use `.agents/memory/`. */
export function renderMemoryRule(): string {
  return [
    "# Agent memory",
    "",
    "Read before reading or writing `.agents/memory/`.",
    "",
    "## Rules",
    "",
    "- `.agents/memory/` is local state, excluded from git: it may hold personal or",
    "  machine-specific data and must never be committed.",
    "- `.agents/memory.template/` is the versioned model: copy it into",
    "  `.agents/memory/` when starting on a fresh clone.",
    "- One file per fact, indexed from `MEMORY.md` — update or delete a memory that",
    "  turns out to be wrong instead of stacking corrections.",
    "",
  ].join("\n");
}
