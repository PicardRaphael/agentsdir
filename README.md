# agentsdir

> Installs into any repo the agent architecture that Codex, Cursor and opencode already read natively — and bridges it to Claude Code.

`agentsdir` is an open source CLI (MIT) that sets up, in an existing project — whatever its language —, a code agent configuration architecture based on open standards:

- **a single source of truth**: the `.agents/` directory (`rules/`, `skills/`, `agents/`, `tasks/`, `plan/`, `memory/`) and the `AGENTS.md` file;
- **per-harness projections**: `CLAUDE.md` and `.claude/*` for Claude Code (symlinks, or synchronized copies when symlinks are not available), `agents/openai.yaml` + an SVG icon per skill for Codex, hook registrations for Claude Code, Codex and Cursor;
- **zero drift**: everything generated is verifiable (`agentsdir check`, wired into CI from installation onwards) and regenerable (`agentsdir sync`).

## Status

**v1.0.0.** The CLI is implemented (`init`, `add skill` / `rule` / `agent` / `hook`, `pack add` / `remove`, `sync`, `check`, `doctor`), tested (Vitest unit tests plus end-to-end tests on ubuntu and windows) and this repo is managed by its own CLI. The entry point is [`docs/roadmap.md`](docs/roadmap.md).

## Why

`AGENTS.md` has become a standard (Agentic AI Foundation / Linux Foundation) read by more than thirty agents, and `.agents/skills/` is the skills convention that Codex, Cursor and opencode discover natively. But no tool installs this complete architecture into a repo, handles the fallback when symlinks are not available (Windows without developer mode), generates the Codex metadata per skill, or registers a single hook in all three harnesses. That is the gap `agentsdir` fills — the full study is in [`docs/recherche/paysage-open-source.md`](docs/recherche/paysage-open-source.md).

## Overview

```bash
npx agentsdir init          # installs the architecture, interactive
npx agentsdir add skill my-procedure
npx agentsdir add rule api-conventions --paths "src/api/**"
npx agentsdir add hook PreToolUse
npx agentsdir pack add verification
npx agentsdir sync          # regenerates the projections
npx agentsdir check         # verifies invariants and drift (CI)
npx agentsdir doctor        # environment diagnostic
```

## Let a coding agent install it

Every question `init` asks has a flag, so an agent already working in your
repository can install without a terminal — and it answers better than a
default, because it has read your scripts, your CI and your README. Paste this
to Claude Code, Codex or Cursor:

> Install agentsdir in this repository. Read the repo first, then run
> `npx agentsdir init` with `--yes` and fill in what you found:
> `--name`, `--description`, `--dev`, `--test`, `--lint`. Use the real commands
> of this project, not generic ones. Then run `npx agentsdir check` and show me
> the result.

The agent ends up writing an `AGENTS.md` describing *your* project, with *your*
commands — the part a generic scaffold always gets wrong.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/SPEC.md`](docs/SPEC.md) | Positioning, design principles, settled decisions |
| [`docs/architecture.md`](docs/architecture.md) | Technical architecture of the CLI, manifest, symlink/fallback strategy |
| [`docs/commandes.md`](docs/commandes.md) | Specification of each command |
| [`docs/creation-assistee.md`](docs/creation-assistee.md) | Assisted creation: meta-skills, quality rubrics, interviews |
| [`docs/conventions.md`](docs/conventions.md) | Installed and validated contracts: skills, rules, managed blocks, lock |
| [`docs/harness.md`](docs/harness.md) | Claude Code / Codex / Cursor integration matrix |
| [`docs/roadmap.md`](docs/roadmap.md) | v0.1 → v1 → v1.x → v2 milestones and acceptance criteria |
| [`docs/recherche/`](docs/recherche/) | Analysis of the source model (NowStack) and competitive landscape |
| [`CHANGELOG.md`](CHANGELOG.md) | What each version adds |

This repo applies its own architecture today: the agents working in it read [`AGENTS.md`](AGENTS.md), and its CI runs `check` against the local build.

> Note: the public documentation and the CLI messages are in English. The internal working documents — `AGENTS.md`, `.agents/rules/`, `docs/recherche/` and the archived [`docs/readme-fr.md`](docs/readme-fr.md) — stay in French.

## License

[MIT](LICENSE) © 2026 Raphael Picard
