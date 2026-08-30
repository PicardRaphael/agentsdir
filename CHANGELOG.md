# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- **`init` can no longer write outside the repository it resolved.** Existence
  was tested with `stat`, which follows symlinks, so a dangling
  `AGENTS.md -> /elsewhere/file` read as absent, was planned as a create, and
  the write landed outside the repo while the report claimed the file had been
  created. Existence is now tested with `lstat` — a symlink is an entry, broken
  or not — a create uses the exclusive `wx` flag so it can never write through
  a link, and a dangling link stops the run with a message naming it.
- **An unreadable hook registry is never overwritten.** `.claude/settings.json`
  and its Codex and Cursor counterparts were treated as absent when they could
  not be read, so the run rewrote them from scratch and dropped whatever the
  user had registered. Only a genuinely absent registry is created; anything
  else refuses with exit `2`.
- **A filesystem failure now respects the exit-code contract.** ENOTDIR, EACCES
  and friends surfaced as a raw stack trace, exited `1` — the code a CI script
  reads as drift — and printed nothing on stdout under `--json`. They now exit
  `2` with an actionable message and a valid JSON object. A `TypeError` still
  keeps its stack trace: that is a bug in the CLI, not something to hand to the
  user as advice.

- **`sync` no longer deletes projections when a source directory cannot be
  read.** An absent directory and an unreadable one were both read as "empty",
  so a `.agents/rules` that could not be listed made `sync` remove its mirrors
  and empty the `rules-index` block — exiting `0`, with `check` green
  afterwards. Silent data loss in a tool whose promise is that nothing drifts
  unnoticed. Only a genuinely absent directory is now treated as empty;
  anything else refuses with exit `2` and names the path and the error code.

- A mistyped command now exits `2` (usage error) with a message naming what was
  not understood, instead of printing the help and exiting `1` — the code a CI
  script reads as "drift detected". `agentsdir sinc`, `agentsdir add skil` and
  `agentsdir pack instal` all report the alternatives.

### Internal

- Consolidation after an architecture audit, with no change in behaviour: the
  projection orchestration, the pack registry, the rules index composition, the
  harness list and the filesystem probes each existed in several copies and now
  live in one place. `src/__tests__/layering.test.ts` fails the build if `core/`
  ever imports from `commands/` or `packs/`, or if two modules import each other
  at runtime. Test helpers moved to `src/test-support/`.

## 1.0.0

First public release.

### Added

- **`init`** — installs the architecture into an existing git repo, of any
  language: the `.agents/` source of truth (`rules/`, `skills/`, `agents/`,
  `tasks/`, `plan/`, `memory/`), `AGENTS.md`, the `.agents.toml` manifest, a
  `.gitignore` managed block and a drift-check GitHub Actions workflow. Every
  write is additive: a full file is written only where nothing exists, and a
  shared file only receives its managed block.
- **Projection engine** — Claude Code reads the same source of truth through
  `CLAUDE.md` and `.claude/{rules,skills,agents}`, materialized either as real
  symlinks (symlink mode) or as synchronized copies carrying a generated header
  (copy mode, the fallback). Symlink support is probed empirically, never
  assumed from the platform: Windows without Developer Mode gets copy mode, and
  copy mode is a first-class citizen tested in CI.
- **`check`** — read-only verification of every invariant, of projection drift
  and of lock fingerprints, with normalized exit codes (`0` ok, `1` drift or
  violated invariant, `2` environment or usage error) and a `--json` output for
  CI. In copy mode every projection is compared to the source of truth
  recomputed from `.agents/`, not to the fingerprint of the last sync, so a
  source edited without a `sync` is reported (`projection-stale`) instead of
  passing silently; a projection whose source was deleted is reported as an
  orphan and removed by `sync`.
- **`sync`** — regenerates every projection from the source of truth. The whole
  plan is computed before anything touches the disk, so a blocked run writes
  nothing and `--dry-run` reports exactly what a real run would do.
  `--mode symlink|copy` switches the projection mode explicitly: the previous
  mode's projections are removed first, then everything is regenerated.
- **Generators** — `add skill` (extended frontmatter as the single catalogue,
  with the Codex `agents/openai.yaml` and `assets/icon.svg` rendered from it),
  `add rule` (template plus the managed rules index in `AGENTS.md`),
  `add agent`, and `add hook <event>` (one portable Node script registered on
  Claude Code, Codex and Cursor at once).
- **Content packs** — `creator` (the assisted-creation meta-skills:
  `$create-skill`, `$create-hook`, `$create-rule`, `$create-agent` and
  `$setup-context`), `verification`, `changelog` and `worktrees`, each
  installable and removable in isolation with `pack add` / `pack remove`.
- **`doctor`** — read-only diagnosis of the machine and the clone; it exits `0`
  even when it finds problems, and names the command that fixes each one.
- **Generators refresh the projections** — `add skill|rule|agent|hook` and
  `pack add|remove` project what they wrote to the enabled harnesses, so a new
  skill is usable immediately in copy mode as it already was in symlink mode.
- **Interoperability with other tools** — a skill installed by another tool
  (`npx skills`, or hand-written to the open Agent Skills spec) is validated
  against that open spec only. `check` reports it as information, never as an
  error, and `sync` leaves its folder untouched.

### Notes

- Requires Node 22 or later.
- Every generated artifact is byte-for-byte deterministic: two runs on the same
  state produce the same bytes, which is what fingerprints and `check` rely on.
- This repo is managed by its own CLI, and its CI runs `check` against the
  local build on both ubuntu-latest and windows-latest.
