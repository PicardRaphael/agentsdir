---
name: setup-context
description: "Builds or improves the AGENTS.md entry point through repo analysis, pre-drafting, a validation interview and line-by-line critique. Use when the user wants to create, improve or complete AGENTS.md or CLAUDE.md, or set up the context AI agents read on the repo."
disable-model-invocation: true
display-name: "Setup Context"
short-description: "Assisted authoring of the AGENTS.md entry point"
color: "#9D174D"
icon: book-open
default-prompt: "Use $setup-context to build or improve AGENTS.md by guided interview."
implicit: false
---

# Setup Context

AGENTS.md is the entry point every agent reads before working; a wrong
line there costs more than an empty file. This meta-skill is /init,
multi-harness and mechanically validated: analyse the repo, pre-draft,
interview only on the non-discoverable, criticize, then write. Six
steps, in order.

## 1. Inventory before writing

- Explore the repo first: the REAL build, test and lint commands
  (package.json scripts, Makefile, CI workflows), the directory
  structure, the conventions the code actually follows. Pre-draft the
  stack and product sections from what you find — never ask what the
  code already answers.
- Inventory the existing agent configs — CLAUDE.md, AGENTS.md,
  `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md` —
  and absorb their content into the draft. NEVER overwrite them: they
  hold the team's accumulated instructions; import them, then propose
  retiring the duplicates.

## 2. Targeted interview

- Ask ONLY what the repo cannot answer. The bank is in
  references/interview.md: the never-run commands, what the agent got
  wrong recently, the conventions diverging from the ecosystem defaults,
  what is already enforced mechanically, the monorepo layout.
- Run it as a validation interview: show the pre-drafted findings and
  the imported material, and ask the user to confirm, correct and fill
  the gaps — not to dictate a file from scratch.

## 3. Routing

- AGENTS.md keeps only what every agent needs on every task. Route the
  rest: a bulky advisory topic becomes a rule listed in the rules index
  (use $create-rule — `agentsdir add rule`); an on-demand workflow is a
  skill ($create-skill); something guaranteed on every event is a hook
  ($create-hook).
- What a linter, the CI or a hook already enforces mechanically is
  EXCLUDED from the file — never send an LLM to do a linter's job.

## 4. Draft, then critique

- Draft in the three families of sections: generic (entry-point
  preamble, rules index, verification), stack (exact commands — build,
  targeted test, lint — plus the explicit never-run commands), product
  (what the product is, the key files). Document only what DIVERGES
  from the ecosystem defaults, and point to README and docs — never
  copy them.
- Criticize line by line with the filter
  question: "if this line is deleted, will the agent make a mistake?"
  Remove every line that fails it, and check the draft against every
  criterion of references/rubrique.md.
- Present the result as a revisable proposal — on an existing AGENTS.md,
  as a list of proposed changes — and get the user's go before writing.

## 5. Generate, then write

- Blank repo: the skeleton comes from `agentsdir init` (already run
  when this pack is installed) — fill its placeholder sections with the
  approved draft.
- Existing AGENTS.md — improvement mode: apply ONLY the changes the
  user approved and keep the user's sections and wording intact;
  propose, never rewrite.
- Never edit inside the managed blocks (`agentsdir:begin` …
  `agentsdir:end`) — they belong to the CLI. Run `agentsdir sync` after
  writing so the rules index and the projections are regenerated to
  match.

## 6. Mechanical validation — mandatory

- Run `agentsdir check`. Any deviation goes back to step 4: never
  conclude with a failing check, and paste the passing check output
  when done.
- Close by suggesting the next steps: $create-skill for the workflows
  the interview surfaced, $create-hook for what must be guaranteed on
  every action.
