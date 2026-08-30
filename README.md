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

## Overview (v1 target)

```bash
npx agentsdir init          # installs the architecture, interactive
npx agentsdir add skill ma-procedure
npx agentsdir add rule conventions-api --paths "src/api/**"
npx agentsdir add hook PreToolUse
npx agentsdir sync          # regenerates the projections
npx agentsdir check         # verifies invariants and drift (CI)
npx agentsdir doctor        # environment diagnostic
```

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
| [`.agents/tasks/`](.agents/tasks/) | v1 backlog, one self-contained task per file |

This repo applies its own architecture today: the agents working in it read [`AGENTS.md`](AGENTS.md).

> Note: the documentation is written in French during the design phase. The README, the public documentation and the CLI messages will be published in English before the first release (see the dedicated backlog task).

## License

[MIT](LICENSE) © 2026 Raphael Picard
