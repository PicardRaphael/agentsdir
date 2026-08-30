# SPEC — vision and scope

## The problem

Every code agent harness reads its own configuration: Claude Code loads `CLAUDE.md` and `.claude/`, Codex reads `AGENTS.md` and `.agents/skills/`, Cursor has `.cursor/`. Teams that use several agents duplicate their instructions, and the copies silently diverge. The standards have nevertheless converged — `AGENTS.md` (Agentic AI Foundation) is read by more than thirty agents and `.agents/skills/` is the skills convention that Codex, Cursor and opencode discover natively — but no tool installs this architecture into an existing repo, nor guarantees that it does not drift.

## The proposal

`agentsdir` installs and maintains, in any repo (Python, TypeScript, Go, it does not matter), a two-layer architecture:

1. **A source of truth**: `.agents/` (rules, skills, sub-agents, tasks, plans, memory) and `AGENTS.md` as the entry point.
2. **Per-harness projections**, regenerable and verifiable: symlinks (or synchronized copies as a fallback) for Claude Code, `agents/openai.yaml` metadata + SVG icons for Codex, hook registrations for all three harnesses.

The tagline: **"installs into any repo the agent architecture that Codex, Cursor and opencode already read natively — and bridges it to Claude Code."**

## The six design principles

1. **One source, many projections.** Everything lives in `.agents/`; `CLAUDE.md`, `.claude/*`, `openai.yaml`, the icons and the rule index in `AGENTS.md` are regenerable projections, never hand-edited.
2. **Nothing imposed on the target repo.** The CLI runs through `npx`; the generated artifacts are pure Markdown, YAML, JSON and SVG. No `package.json` required, no runtime dependency in the project.
3. **Everything generated is verifiable.** `agentsdir check` validates the invariants and detects drift, with an actionable exit code; the CI workflow is emitted from `init` onwards.
4. **Additive and idempotent.** `init` on an already populated repo only touches its own files; in an existing `AGENTS.md`, the CLI only writes inside its managed blocks (`<!-- agentsdir:begin … -->`).
5. **The frontmatter is the catalog.** A skill's metadata (display name, color, icon, prompt) lives in the frontmatter of its `SKILL.md`. Adding a skill = creating a folder, never editing a script.
6. **Stack detection, not stack dependency.** `init` detects the project language only to pre-fill the commands (dev, test, lint) and to suggest the relevant packs.

## What the project is not (deliberately out of scope)

- **Not a synchronizer to 40 exotic harnesses**: three major harnesses served well (Claude Code, Codex, Cursor) rather than a fragile matrix of adapters. The other `AGENTS.md` readers already work without an adapter.
- **Not a skills marketplace**: `agentsdir` interoperates with the skills installed by `npx skills` (Vercel) and follows the agentskills.io specification; it does not distribute content.
- **Not a proprietary format**: no intermediate directory to learn (unlike `.ruler/` or `.rulesync/`). What the CLI installs is exactly what the harnesses read.
- **Not a prompt generator**: the quality of the content of the rules and skills belongs to the user; the CLI provides the templates, the contracts and the verification.

## Settled decisions

| Decision | Choice | Date |
| --- | --- | --- |
| Name | `agentsdir` (available on npm, verified) | 2026-08-27 |
| License | MIT | 2026-08-27 |
| Distribution | `npx` (compiled binaries possible later) | 2026-08-27 |
| v1 harnesses | Claude Code, Codex, Cursor | 2026-08-27 |
| v1 scope | Generic core + packs (verification, changelog, worktrees) | 2026-08-27 |
| worktrees pack | Included in v1, rewritten in portable Node | 2026-08-27 |
| Symlinks | Real detection + fallback to synchronized copies | 2026-08-27 |
| Skills catalog | Extended frontmatter of `SKILL.md` | 2026-08-27 |
| Language of the CLI and the public docs | English at release; design in French | 2026-08-27 |
| Assisted creation | In v1: `creator` pack + `$setup-context`, hybrid approach (CLI = structure, meta-skills = interview) | 2026-08-28 |
| Repo analysis | `$setup-context` has the agent analyze the code to pre-draft AGENTS.md | 2026-08-28 |
| `update` | Upgrades untouched CLI content (tracked by fingerprint), preserves and reports the modified ones | 2026-08-28 |
| Product direction | Be the reference for `init` **and** govern what was installed: no race on harness count, `vendor` and `migrate` demoted to catching up. See [positionnement.md](positionnement.md) | 2026-08-30 |
| Publication gate | v1.0.0 is held until `init` proposes content fit for the repository (task 24) and the "five minutes with the README alone" criterion has actually been verified | 2026-08-30 |

## Origin

The architecture installed by `agentsdir` is a generalization of the model observed and analyzed in depth in the NowStack repo (multi-harness SaaS starter), stripped of the flaws found in it — the full analysis is in [recherche/analyse-nowstack.md](recherche/analyse-nowstack.md), the market study in [recherche/paysage-open-source.md](recherche/paysage-open-source.md).
