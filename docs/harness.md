# Harness matrix

This document lists, for each harness targeted by v1, what it reads, how it discovers skills, and what `agentsdir` must project for it. Status as of August 2026 (detailed sources in [recherche/paysage-open-source.md](recherche/paysage-open-source.md)).

## 1. Who reads what

| Harness | Instructions | Skill discovery | Own files | Hooks |
| --- | --- | --- | --- | --- |
| **Claude Code** | `CLAUDE.md` only (does not read `AGENTS.md`) | `.claude/skills/` | `.claude/settings.json` (permissions, hooks), `.claude/agents/` (sub-agents) | yes — `.claude/settings.json` |
| **Codex (OpenAI)** | `AGENTS.md` (native) | `.agents/skills/` scanned natively, from the cwd up to the root | `agents/openai.yaml` + icon per skill; `.codex/config.toml` (if the repository is "trusted") | yes — `.codex/hooks.json` |
| **Cursor** | `AGENTS.md` (native) | `.cursor/skills/` or `.agents/skills/`, picked up anywhere in the repository | `.cursor/worktrees.json` (officially documented) | yes — `.cursor/hooks.json` |
| **Other AGENTS.md readers** (opencode, Gemini CLI, Copilot, Zed, Windsurf, Aider…) | `AGENTS.md` (native) | opencode reads `.opencode/skills`, `.claude/skills` then `.agents/skills`; varies by tool | none required | varies |

How to read the matrix: **the `.agents/` source of truth is already readable natively by everyone except Claude Code**. The projection work therefore focuses on Claude Code (symlinks or copies to `CLAUDE.md` and `.claude/*`) and on the Codex interface metadata (`agents/openai.yaml` + icon per skill).

## 2. Adoption facts (August 2026)

- **AGENTS.md is a standard**: launched by OpenAI in August 2025, transferred to the Agentic AI Foundation (Linux Foundation) for neutral governance. More than 60,000 public repositories, read natively by more than 30 agents.
- **Claude Code is the exception**: it only reads `CLAUDE.md`; the demand for native `AGENTS.md` support is massive but has received no official answer. This is precisely the projection that `agentsdir` installs — and the "bridge" half of the value proposition.
- **Agent Skills (SKILL.md) is an open standard**: specification published by Anthropic at the end of 2025 (agentskills.io), adopted within 48 hours by Microsoft and OpenAI; more than 30 tools read it.
- **`.agents/skills/` is the cross-client convention**: Codex scans it natively, Cursor picks it up anywhere in the repository, opencode reads it as a last resort. Installing this convention means following the standards, not imposing a proprietary format.
- **`agents/openai.yaml` is the official format** for skill metadata in Codex/ChatGPT (`display_name`, `short_description`, icons, `brand_color`, `default_prompt`, invocation policy). No surveyed tool generates it automatically: it is a clear differentiator for `agentsdir`.

## 3. Hooks: one portable script, three registrations

The three harnesses have converged on the **same event set** — `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`… — but their registration files are incompatible. Formats revalidated on 2026-08-29 against the three official documentation sites (code.claude.com/docs/en/hooks, developers.openai.com/codex/hooks, cursor.com/docs/hooks); the exact matrix as coded lives in `src/core/hook-registries.ts`:

- **Claude Code** — `.claude/settings.json`: `hooks` wrapper, `{ "matcher": "…", "hooks": [{ "type": "command", "command": "…" }] }` groups per event.
- **Codex** — `.codex/hooks.json`: the same `hooks` wrapper and the same groups as Claude, in a dedicated file. (Correction of 2026-08-29: an earlier version of this document claimed "events at the root, without a wrapper" — the official documentation published by OpenAI shows the `hooks` wrapper; third-party guides still diverge, the official documentation prevails.)
- **Cursor** — `.cursor/hooks.json`: mandatory `"version": 1`, `hooks` wrapper, event keys in lowerCamelCase with renamings (`preToolUse`, `stop`, `sessionStart`, and `beforeSubmitPrompt` for `UserPromptSubmit`), flat entries `{ "command": "…" }`. The `matcher` exists there but with Cursor's own tool vocabulary (`Shell`, not `Bash`): a matcher written for Claude matches nothing there — so `add hook` never projects it on the Cursor side.

The hook script itself is portable (dependency-free Node, JSON input on stdin). Hence the `add hook` generator: write the script once, register it three times.

```mermaid
flowchart LR
    S[".agents/hooks/&lt;name&gt;.mjs<br/>portable script — written once"]
    S --> A[".claude/settings.json<br/>hooks wrapper + matcher"]
    S --> B[".codex/hooks.json<br/>hooks wrapper, matcher groups"]
    S --> C[".cursor/hooks.json<br/>version: 1, lowerCamelCase keys"]
```

**Warning**: Cursor's hook formats have already broken between two versions of the tool. Every `agentsdir` release must revalidate the three registration formats against the current documentation, and `doctor` must report an unknown format rather than writing blindly.

## 4. MCP servers: one declaration, three configurations

A repository that declares MCP servers used to say it three times, in three formats, and keep them in step by hand. `.agents/mcp.toml` declares them once and `sync` projects them. Formats validated on 2026-09-13 against the three official documentation sites; the exact matrix as coded lives in `src/core/mcp.ts`:

| | Claude Code | Cursor | Codex |
| --- | --- | --- | --- |
| File | `.mcp.json` (repo root) | `.cursor/mcp.json` | `.codex/config.toml` |
| Format | JSON | JSON | TOML |
| Envelope | `mcpServers` | `mcpServers` | `[mcp_servers.<name>]` tables |
| Transport | explicit `type`: `stdio`, `sse`, `http` | implicit — a remote server is one with a `url` | implicit, same rule |
| Variables, stdio | `env: { NAME: "${NAME}" }` | `env: { NAME: "${env:NAME}" }` | `env_vars = ["NAME"]` |
| Variables, headers | `headers: { H: "${NAME}" }` | `headers: { H: "${env:NAME}" }` | `env_http_headers = { H = "NAME" }` |
| Source consulted | code.claude.com/docs/en/mcp | cursor.com/docs/context/mcp | learn.chatgpt.com/docs/extend/mcp |

Three consequences worth stating, because they shaped the code:

- **Codex interpolates nothing.** Neither `${VAR}` nor `$VAR` is expanded anywhere in `config.toml`. It has two dedicated keys instead: `env_vars` forwards named variables from the environment to a stdio server, and `env_http_headers` maps a header name to a variable name. Writing `[mcp_servers.x.env]` would set a **literal value** — precisely what must never be committed.
- **`.codex/config.toml` holds the whole Codex configuration**, not just MCP, so it is never reparsed and rewritten: agentsdir keeps a managed block (`# agentsdir:begin mcp`) at the end of the file and leaves every other byte alone. The block must stay last — in TOML, a key written below it would belong to the server table above — and `check` fails with `mcp-block-not-last` if that happens. Codex reads a project-level `config.toml` only for a trusted project; that is the user's decision, not this CLI's.
- **Cursor has no `type` field.** Emitting one would put a key in the user's file that its documentation does not describe.

```mermaid
flowchart LR
    S[".agents/mcp.toml<br/>declared once — variable names, never values"]
    S --> A[".mcp.json<br/>type + ${VAR}"]
    S --> B[".cursor/mcp.json<br/>no type + ${env:VAR}"]
    S --> C[".codex/config.toml<br/>managed block, env_vars"]
```

**Not covered.** The task file behind this work (August 2026) noted a recent revision of the MCP specification and a "Skills over MCP" working group that may bring the two objects of this product together; neither was re-verified on 2026-09-13, and neither is anticipated here: what is projected is what the three harnesses document today, to be reassessed when that group publishes. Launching, supervising or reaching a server stays out of scope — this CLI installs and verifies configuration.

## 5. Non-standardized points, or points to verify

- **`.codex/environments/environment.toml`**: observed in the NowStack repository (marked "autogenerated", probably written by the Codex application itself), but corroborated by **no public documentation** — Codex cloud environments are configured in the web interface. The CLI **must not generate this file in v1**; to be reassessed if OpenAI documents it.
- **`.cursor/worktrees.json`**: officially documented by Cursor (keys `setup-worktree`, `setup-worktree-unix`, `setup-worktree-windows` pointing to scripts). It is the target of the worktrees pack.
- **`conductor.json`** (Conductor): same pattern as Cursor (`setup`/`archive` scripts), out of v1 scope but trivial to add if requested.
- **`.codex/config.toml`**: loaded by Codex only for a repository trusted on its side. Since task 27 it carries the MCP managed block described in §4; nothing else in it is written by this CLI.

## 6. What each harness receives after `init`

**Claude Code**
- `CLAUDE.md` → projection of `AGENTS.md` — a symlink, or a copy with a header in copy mode (fallback);
- `.claude/rules`, `.claude/skills`, `.claude/agents` → projections of `.agents/*`;
- `.claude/settings.json`: a permission allowlist covering the scripts the installed packs tell an agent to run (`Bash(node <script> *)` rules, merged in without touching anything else in the file), and hook registrations where applicable. Hook scripts get no rule: the harness runs those itself, outside the Bash tool.

**Codex (OpenAI)**
- `AGENTS.md` read as is (a real file, no projection needed);
- `.agents/skills/` scanned natively; per skill, `agents/openai.yaml` + `assets/icon.svg` generated from the frontmatter (see [conventions.md](conventions.md));
- `.codex/hooks.json` if hooks are installed.

**Cursor**
- `AGENTS.md` read as is; `.agents/skills/` picked up natively;
- `.cursor/worktrees.json` if the worktrees pack is installed;
- `.cursor/hooks.json` if hooks are installed.

**Other AGENTS.md readers** (opencode, Gemini CLI, Copilot…)
- Nothing to generate: `AGENTS.md` and `.agents/skills/` are enough. This is the direct consequence of the "follow the standards" choice: every new conformant harness is covered for free.

## 7. Adding a harness: what to declare

Adding a fourth harness is a settled-decision change ([SPEC.md](SPEC.md)), not a casual edit — but once the decision is taken, it is **one entry in one table**. `HARNESS_SPECS` in `src/core/harnesses.ts` is the single declaration, and everything else derives from it: the detection probes, the hook registrations, the event keys, the permission allowlist and the decision to project files at all.

| Field | What it says | Consequence if wrong |
| --- | --- | --- |
| `dir` | Configuration directory at the repository root | The harness is never detected in a repo, and `doctor` reports it as enabled but found nowhere |
| `hookRegistry` | Where its hook registrations live, or `undefined` when it takes none | Hooks are registered nowhere, so no harness runs them — `check` reports `hook-registration-drift` |
| `eventCase` | `canonical` keeps the Claude Code / Codex name, `lowerCamel` lowercases the first letter | Registrations land under a key the harness never reads; nothing fails, nothing runs |
| `unsupportedEvents` | Canonical names of the events it does not support | `add hook` offers an event the harness will ignore |
| `eventAliases` | Events it spells neither canonically nor by case | Same as above, for the one event that is renamed outright rather than recased |
| `projectsFiles` | Whether agentsdir generates files in its directory | A harness with no projections would get a `.claude`-style mirror it never reads, and `check` would then hold it to invariants about files nobody loads |

**What you do NOT have to edit**: the twelve entries of `HOOK_EVENTS`. They carry a canonical name and nothing else. Each used to hold one field per harness, which is what made a fourth harness the most expensive change in the CLI — and the reason this was task 19.

Two things still need a human decision, because no declaration can infer them: whether the harness reads `AGENTS.md` as is (most do, and then there is nothing to project), and the exact shape of its hook registry file if it differs from the two already supported — Claude Code's matcher groups and Cursor's flat entries are the two shapes implemented in `core/hook-registries.ts`.

See also: [architecture.md](architecture.md) (projection engine), [commandes.md](commandes.md) (`init`, `sync`, `check`, `add hook`), [roadmap.md](roadmap.md) (v1 scope).
