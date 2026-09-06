# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 — unreleased

First release, built and verified but not published to npm yet: publication is
held until `init` proposes content fit for the repository rather than an empty
skeleton. This entry gets its date on the day it ships.

### Security

Paths and content coming from a repository are treated as untrusted input. A
cloned repository could otherwise make the CLI act outside the git root it had
resolved, on the first ordinary command.

- **Paths declared by the repository stay inside it.** The fingerprint keys of
  `.agents.toml` and the skill names of `skills-lock.json` are used to build
  file paths, and `path.join` normalises `..` instead of rejecting it — a
  crafted key was enough to have files read, written or **deleted** outside the
  repository, silently, in the middle of an ordinary report. Every derived path
  now resolves through a single guard that refuses anything escaping the root.
- **Projections are never written through a symlinked directory.** A repository
  shipping `.claude/rules` as a link elsewhere had its projections written
  outside the root, and the report looked perfectly normal.
- **Rule files that are symlinks are skipped, not followed.** The first line of
  each rule is lifted into the `rules-index` block of AGENTS.md — a file the
  user commits and pushes — so a link out of the repository leaked outside
  content into version control, one line per link.
- **Hook script names are validated before registration.** The name is
  interpolated into the `node .agents/hooks/<file>` command a harness will run;
  a name carrying shell syntax is now refused rather than registered.
- **A lock key is a folder name, never a path.** The keys of
  `skills-lock.json` were used as path segments, so an entry naming a traversal
  had a directory outside the repository read and fingerprinted, its digest
  written back into the lock. Keys are now held to the skill-name grammar and
  refused before any disk access.
- **A rule cannot break the managed block of AGENTS.md.** A first line carrying
  a block marker split the block in two, so every `sync` appended another copy
  and `check` stayed red for good.
- **A symlinked directory can no longer be used to escape the repository.**
  `mkdir -p` and `readdir` both walk through one without complaining. The guard
  that refuses to project through a linked parent existed, but covered a single
  write path out of five. A cloned repository shipping
  `.agents/rules/x.md → ../../.env` had the first line of a secret written into
  the `rules-index` block of `AGENTS.md` — a file the user then commits and
  pushes; one shipping `.claude → ~/.claude` had the user's **global** Claude
  Code settings rewritten, with our hook registered in them. The guard now
  covers symlink projection, hook registries, the generators, and the source
  directories themselves — a linked `.agents/rules` was read straight through.
- **`pack add` no longer writes through a broken symlink.** It was the last
  generator still testing collisions with `stat`, which follows links: a broken
  one reads as absent, and the write then lands at the far end, outside the
  repository.
- **The CI workflow written into your repository pins its version.** It ran
  `npx agentsdir check` on every push, unpinned, with the repository checked out
  and the default `GITHUB_TOKEN` in scope — executing whatever the registry
  served that day. It is now pinned, `--yes`, and restricted to
  `contents: read`.
- **A mistyped option no longer runs the real thing.** citty silently ignores
  options nobody declares, so `agentsdir init --yes --dryrun` installed the
  whole architecture and exited 0 while the user believed they were simulating.
  Unknown options are now a usage error naming the valid ones.

### Added

- **`agentsdir update` exists.** The lock has always separated the content the
  CLI installed (`sourceType: "agentsdir"`) from the content vendored from
  elsewhere, so that an upgrade could replace the first without touching the
  second — and nothing ever read that distinction. `update` is the key to that
  lock: it walks the declared manifest-schema transformations, replaces
  installed content that is still intact, and, for a file you edited that also
  moved upstream, shows the diff and offers the merge instead of overwriting
  it. Without a terminal to ask, it decides nothing, writes nothing and exits
  `1`. It ends with a full `sync`. `check` and `doctor` used to point at a
  command that did not exist; they now point at one that does.
- **A coding agent can install agentsdir without a terminal.** Every interview
  question now has a flag — `--name`, `--description`, `--dev`, `--test`,
  `--lint`, on top of the existing `--harness`, `--packs` and `--mode`. An agent
  already working in the repository has read the scripts, the CI and the README,
  so it answers better than any default; it just needed somewhere to put the
  answers. The README carries a prompt ready to paste.

### Fixed

- **A mode switch can no longer leave a repository half in each mode.** The
  copies were deleted first and the arrival mode classified afterwards, so a
  target agentsdir did not own aborted the run once the removal was
  irreversible: `CLAUDE.md` had become a link, the copies were gone, and the
  manifest still announced `mode = "copy"` — a state no command could describe
  or repair. The whole plan is now computed before the first deletion, and a
  foreign target aborts while the repository is still untouched.
- **`--dry-run` no longer promises a switch that would fail.** Planning a mode
  switch assumed a clean slate, which short-circuited the classification
  entirely: no foreign target could be reported, in a dry run or anywhere else.
  The plan now classifies the real disk, minus what the removal would take.
- **Removing a harness from `[harness] enabled` removes its projections.** The
  documented path did nothing: `check` skipped the projections of a disabled
  harness and reported "no drift", `sync` reported "0 removed" while emptying
  `[projections.hashes]`, and `CLAUDE.md`, the copies and the hook registrations
  stayed on disk — loaded by the harness, updated by no sync, and green in CI.
  `check` now reports them and `sync` removes them, hook registrations included.
  `check` holds every hook registry found on disk to the contract, not only
  those of the enabled harnesses, so a malformed one cannot pass the check and
  then fail the sync.
- **`sync` never empties `[projections.hashes]` while the files stay.** The
  fingerprints of a projection it may not remove are kept with it, instead of
  losing the record of what had been written.
- **A repository with its own `.gitattributes` is no longer stuck in drift.** An
  existing file was kept without a word, so a repository declaring `* text=auto`
  without `eol=lf` came out of a Windows checkout in CRLF while the expected
  bytes were built with LF: `check` stayed red whatever the user did. `init` now
  appends a `line-endings` managed block pinning the projected paths to LF,
  leaving the repository's own normalization policy alone.
- **A symlink materialized by a checkout is repaired instead of refused.** This
  is the founding scenario of the product: a repository projected with symlinks,
  cloned where they cannot be created, has git write the link target as the file
  content. Such a file is ours — but it was classified as foreign, so `check`
  said "run `agentsdir sync`" and `sync` refused, with no documented way out.
  `sync` now restores the link, and both messages state the real fix.
- **`check` verifies the sub-agent frontmatter (invariant 14).** A
  `.agents/agents/*.md` without a usable `name` and `description` is silently
  ignored by Claude Code: nothing fails, the agent is simply never offered.
  `docs/conventions.md` announced the invariant; nothing implemented it.
- **`check` verifies the hook script protocol (invariant 15).** Registering a
  script proved it was declared, never that it could run. Each script an event
  can be attributed to is now invoked once, dry, with the sample payload of its
  event on stdin, and held to the protocol its own template documents: an empty
  stdout or one JSON object, exit code `0` or `2`. The invocation is bounded —
  five seconds, capped output, stdin closed after the payload, no environment
  variable added — so a hook that never returns is a named violation instead of
  a hung CI.
- **`check` fails on a projection git records as a symlink but holds as text.**
  The detection existed and only `doctor` consumed it, so `check` covered the
  disk half of invariant 11 and not the git half: a repository in copy mode
  carrying a leftover `120000` entry passed, and the next clone on a machine
  with symlink support turned each of those files into a link pointing at its
  own content. `doctor` keeps its explanation; `check` now fails.
- **The lock covers the rules and scripts the CLI installs, not just skills.**
  `docs/conventions.md` promised `sourceType: "agentsdir"` tracked the generic
  rules and templates, and nothing did — a rule edited by hand was
  indistinguishable from one still pristine, which is precisely what the
  `update` protection has to tell apart before it overwrites anything. A `files`
  table now records what an install actually wrote; a file the repository
  already had is deliberately left untracked.
- **`init` no longer crashes on a large repository.** `git ls-files -sz` ran
  with Node's default 1 MiB output cap; past a few tens of thousands of tracked
  files it threw, and `init`, `sync` and `doctor` all reach it.
- **Refusing an already-configured repository now says what to do.** The message
  pointed at `agentsdir migrate`, which does not exist. The README gained a
  "Before you run it" section: prerequisites, that refusal, and what `init`
  actually writes.
- **The third-party notice ships with the package.** The bundle embeds icon
  paths from `lucide-static` (ISC), some derived from Feather (MIT); `files`
  shipped `dist` alone, so the tarball redistributed them without the notice
  both licences require in every copy.
- **An unreadable file is no longer reported as a missing one.** A `SKILL.md`
  that could not be read was announced as absent, with the advice to "write it
  or delete the folder" — wrong on both counts for a file that is there. Same
  for a projection: `sync` cannot recreate what it cannot read, so the message
  now names the error instead of sending the user in circles.

- **A file too large to read no longer advises fixing permissions.** Exceeding
  the maximum string length of the runtime raised a `RangeError`, which was
  reported with the message written for filesystem errors — advice that had
  nothing to do with the problem. It now says which kind of file is too large
  and what to do about it.
- **A lone carriage return no longer passes as a single-line frontmatter
  value**, where it would have travelled into the generated YAML.

- **Files land whole or not at all.** Every write now goes to a sibling
  temporary file and is put in place by a single rename, so an interrupted run
  leaves either the old content or the new one — never a half-written file. The
  project already applied this pattern to the scripts it generates; it now
  applies it to itself. A create is exclusive, which is also what keeps it from
  writing through a symlink.

- **A write killed mid-file is repairable again.** A truncated copy lost its
  generated header, read as a foreign file, and `sync` refused the very repair
  `check` was demanding — a dead end whose only way out was deleting the file by
  hand. A copy that is a strict prefix of what the CLI would write is now
  recognised as an interrupted write and regenerated; a projection someone
  actually edited still reads as foreign and is still refused, untouched.

- **`check` now inspects the hook registries, like `sync` does.** A malformed
  `.claude/settings.json` (an array, or invalid JSON) passed `check` with exit
  `0` while `sync` refused to run — CI green on a repository that could not be
  synced. The registries of every enabled harness are held to the same contract
  by both commands (`hook-registry-invalid`).

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
