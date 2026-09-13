# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 — unreleased

First release, built and verified but not published to npm yet: publication is
held until an unfamiliar user can install agentsdir in under five minutes with
the README alone. This entry gets its date on the day it ships.

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

- **And it can now find out whether that cost buys anything.** The `usage`
  pack observed; it now concludes. `$review-usage` turns the journal into a
  review saying three things, and the third is the one nobody else writes:
  what serves, what was never seen, and **what the measure cannot say**.
  Crossed with the context budget, the two answer the only question a team
  asks: is this skill worth what it costs?

  Two properties shape it. The first is an asymmetry: **a presence is proved
  by one line, an absence is not.** So the review states the volume it rests
  on and refuses to conclude that anything is unused below 20 sessions over 14
  distinct days — both conditions, because twenty sessions in one afternoon
  say nothing about a skill that serves at release time. The list of what WAS
  used is printed regardless. The second is vocabulary: **a rule is not
  invocable**, and no hook can say whether an agent read one, so rules are
  reported as *relevant* or *never relevant* — never as used — and a rule with
  no `paths:` scope has nothing to meet, so it lands in the limits section
  rather than among the dead ones, with the cost it pays at every session.

  The arithmetic is a dependency-free script, not a prompt telling the agent
  to read the journal: a month of sessions is thousands of JSONL lines, and
  pouring them into the context window to count them is the exact waste the
  budget report exists to expose. The script counts and writes nothing; the
  meta-skill interviews, judges and proposes. Nothing is ever deleted — every
  removal carries its data (sessions observed, last occurrence, cost per
  session) and stays a proposal. And the review closes on why it exists: the
  harness already arbitrates this silently, truncating skill descriptions at
  1,536 characters in the listing and, after a compaction, re-attaching them
  most-recently-invoked first within a 25,000-token budget, where older ones
  can be dropped entirely. The review makes a
  decision taken in the team's back visible and arguable.

- **A repository can now find out what its configuration costs in context.**
  Everything this CLI installs is paid, at every session, in the context
  window — and nothing measured it. `doctor` now reports what each installed
  element weighs and, more importantly, **when** it is paid: `AGENTS.md`, the
  metadata of every skill and sub-agent and the unscoped rules are paid at
  every session; a skill body and its `references/` only on invocation; a
  scoped rule only when the session touches a file it covers. The distinction
  is the whole point — a report that adds the three together produces an
  impressive, false number, and a report that treats every rule as conditional
  under-reports the session cost just as badly.

  The nature of every figure is stated where the figure is read. Bytes and
  lines are exact; **tokens are an estimate**, one per 4 characters, printed
  with a `~` — an exact count would need the target model's tokenizer, hence a
  heavy dependency this project refuses. The divisor was calibrated once
  against a real BPE over 33 Markdown files (4.03 characters per token
  observed, 0.9% over-estimate at 4), and the report carries the divisor and
  the calibration next to the numbers, in the terminal and in `--json` alike.

  It also checks two Agent Skills bounds nothing verified before: a
  `description` over 1024 characters, and a body over ~5000 tokens — the one
  that catches a `SKILL.md` made of few but very long lines, which the existing
  500-line invariant cannot see. An overrun **informs**: `doctor` exits 0
  whatever the budget says, and `check` stays the guardian of drift, not of
  sobriety. The terminal shows the heaviest twelve items per block so a
  sixty-skill repository stays readable; `doctor --json` carries every item
  under a `context` key, which is what makes the budget followable over time.
  Measured cost of the measure itself: 16.3 ms on a 60-skill repository.

- **A repository can now find out whether its configuration is of any use.**
  `check` always answered "has this drifted from its source?"; nothing answered
  "does anyone use this?" — a skill nobody invokes, a sub-agent never delegated
  to, a rule whose scope never meets the files a session touches. The new
  `usage` pack (optional, never installed by default) registers collectors on
  Claude Code, Codex and Cursor at once, which no comparable tool can do
  because no other tool installs multi-harness hooks, and writes a local
  journal of what actually happened: skills invoked, sub-agents delegated to,
  tools used, repo-relative paths touched.

  Privacy is the constraint that shaped it, because this installs into
  somebody else's repository. No prompt, no file content and no command line
  ever reaches the journal — the collector reads an allow-list of payload keys
  rather than the payload. A path that resolves outside the repository is
  dropped, and `[usage].exclude` keeps whole subtrees out with the globs of
  `add rule --paths`, because `src/clients/acme/contract.ts` names a client all
  by itself. The journal lives under `.agents/output/`, which git ignores, and
  `check` now **fails** if git tracks it anyway: the real danger was never the
  journal, it was the journal committed by mistake. Collection suspends with
  `[usage].enabled = false` without uninstalling anything, files rotate daily
  and are pruned after 30 days at session boundaries, and `pack remove usage`
  takes the scripts, the registrations and the journal with it. Measured cost:
  7.6 ms per tool call on top of the Node process the harness starts anyway.
  A path carrying a Windows drive letter or a UNC prefix is refused on every
  platform, not only where the operating system calls it absolute: on Linux
  such a path is an ordinary relative file name, and the journal would have
  recorded it, username included. The format is the contract of the analysis
  stage to come, specified in `docs/conventions.md` §9.
- **`init` no longer leaves the user in front of an empty structure.** The
  architecture landed installed and blank: `.agents/rules/` held the generic
  rules only, `.agents/hooks/` and `.agents/agents/` held nothing, and nothing
  said what would make sense for *this* repository. The new `$propose-setup`
  meta-skill of the `creator` pack reads the repo — stack markers and the
  commands they prove, `package.json` scripts, CI workflows, linter configs,
  what is already configured — and puts up one table: the hooks, rules and
  sub-agents that earn their place here, each with its reason and its
  evidence, every fact marked as read from a file or assumed from a
  convention. Each line is accepted, refused or amended on its own, nothing is
  written before every line has a verdict, and what a linter, the CI or an
  existing hook already enforces is excluded rather than proposed. The
  accepted lines are then created through `$create-hook`, `$create-rule` and
  `$create-agent`, so no creation protocol is replayed. The last lines of
  `init` point at it, and only when the `creator` pack was installed.
- **The meta-skills check the current guidance before settling an artifact.**
  What a skill, a hook or a sub-agent is good for — and the fields it supports
  — moves with the harnesses and the models that run them, and a pack shipped
  by npm cannot move at that rate. `$create-skill`, `$create-hook`,
  `$create-agent` and `$propose-setup` now have the agent consult the primary
  sources first, whatever the medium: what the people who build that harness or
  that model publish themselves — documentation, talks and recorded sessions,
  papers and slide decks — never a third party's paraphrase of one. What was
  consulted is recorded with its date, and an offline run says so instead of
  guessing. The CLI itself still opens no connection: `check` and `doctor` stay
  offline by design and by test.
- **`agentsdir update` exists.** The lock has always separated the content the
  CLI installed (`sourceType: "agentsdir"`) from the content vendored from
  elsewhere, so that an upgrade could replace the first without touching the
  second — and nothing ever read that distinction. `update` is the key to that
  lock: it walks the declared manifest-schema transformations, replaces
  installed content that is still intact, and, for a file you edited that also
  moved upstream, shows the diff and offers the merge instead of overwriting
  it. Without a terminal to ask, the conflicted file is left untouched, its diff
  printed, and the run exits `1` — the rest of the update still applies. It ends with a full `sync`. `check` and `doctor` used to point at a
  command that did not exist; they now point at one that does.
- **A coding agent can install agentsdir without a terminal.** Every interview
  question now has a flag — `--name`, `--description`, `--dev`, `--test`,
  `--lint`, on top of the existing `--harness`, `--packs` and `--mode`. An agent
  already working in the repository has read the scripts, the CI and the README,
  so it answers better than any default; it just needed somewhere to put the
  answers. The README carries a prompt ready to paste.
- **The generators can be answered without a terminal too.** `add skill` asked
  six questions and offered no flag for any of them, so off a TTY — the path a
  coding agent takes — every catalogue field fell back to a generic template
  value. All six now have a flag (`--description`, `--display-name`,
  `--short-description`, `--color`, `--icon`, `--default-prompt`), as do
  `add rule --hook` and `add agent --description`. A flag is refused by the same
  rule as the prompt it replaces.
- **`init --json`.** The command an agent runs first was the only one whose
  result it could not read: the flag was accepted by nothing, the output stayed
  the human report. `init` now writes the same single object as the other nine
  commands, and implies `--yes` — the interview writes its prompts to the very
  stdout a script came to parse.
- **`.claude/settings.json` carries the permission rules for the scripts the
  packs install.** A pack could lay down a skill whose procedure runs a script
  through `node` while nothing allowed it, so Claude Code asked every single
  time. `init`, `sync`, `pack add` and `pack remove` now maintain those rules.
  JSON has no comment markers to delimit a managed block, so ownership is
  structural — a rule is agentsdir's iff it reads
  `Bash(node <path under .agents/> *)` — and everything else in the file is
  preserved, in place and in order.

### Fixed

- **`check` passed green on a repository it could not read.** An unreadable
  `.agents/agents` — a permission change, a broken checkout, a path replaced by
  a file — was read as "this repository has no sub-agents", so every sub-agent
  invariant validated an empty set and the CI gate went green on a repository
  it never saw. `.agents/skills` had the same hole, hidden behind the lock
  whenever one existed, and `doctor` billed both directories at zero in the
  context budget it reports. The 1.0.0 fix that taught the projection engine to
  tell an absent directory from an unreadable one missed five call sites;
  every directory read now goes through the same helper, which returns nothing
  for an absent directory and refuses on any other error, and a test refuses a
  new bare `readdir` outside a named handful, each listed with its reason. `doctor` reports the refusal as a
  finding instead of failing, so it stays usable on the broken repository it is
  run to diagnose.
- **`sync` silently deleted the `[usage]` section of the manifest.** A
  repository that had suspended collection (`enabled = false`) or configured
  privacy exclusions (`exclude`) lost both on the next `sync`: collection
  resumed on its own, and the paths the user had deliberately kept out of the
  journal started being recorded again. The cause was structural — `sync`
  rebuilt the manifest field by field, and the section added later was never
  added to that list. Manifest state is now carried forward wholesale, and one
  gate renders and writes the file for every command.


- **`update` now installs content a pack gained after you installed it.** It
  walked `skills-lock.json` and nothing else, so an artifact the pack did not
  carry at install time was named by no entry and was never installed: a
  repository stayed on the meta-skills of the version it first ran `pack add`
  with, upgrade after upgrade, with no command able to bring it the new ones.
  Content a declared pack gained is now created and locked like any other
  upgrade, in the same plan — and a folder of that name the repository already
  owns is left untouched, exactly as `pack add` refuses to collide with one.
- **`pack add` registers the hooks a pack ships.** It planned no registration
  at all — true only because no pack had ever shipped one. The `usage` pack
  does, and its collectors would have sat on disk, installed and running on no
  harness, until the next `sync`. Registration and deregistration now happen
  in the same plan as the install and the removal, dry run included. In the
  same pass, pack hook scripts became lockable (`update` upgrades them,
  `check` reports a local edit) and stopped being announced in the Claude Code
  Bash allowlist — the harness runs them itself, outside the Bash tool, which
  is what the code comment had claimed all along.
- **`skills-lock.json` has one rendering again.** `init` seeded a sorted lock
  while `pack add` appended to the `skills` table in install order (it already
  sorted `files`, which is what made the asymmetry easy to miss). Two
  repositories in the same declared state therefore held different bytes, in a
  generated file the fingerprints and `check` rest on. Every writer now goes
  through one renderer, and a lock an older CLI left in insertion order is
  normalised by the next `sync`.
- **Copy mode no longer hides a skill's or a sub-agent's frontmatter.** The
  generated header was written ahead of the file, so a projected `SKILL.md` or
  sub-agent no longer opened on its YAML frontmatter — and a harness only parses
  frontmatter that starts on the very first byte. Claude Code dropped projected
  sub-agents from its delegation list entirely, and read projected skills
  without their metadata: the description it showed was the header comment, and
  `disable-model-invocation` was ignored, so a skill meant to stay out of the
  context window was injected into every session. `check` was green throughout:
  the copies matched the expected rendering byte for byte. A Markdown source
  that opens with a frontmatter block now keeps it first and takes the header
  right after it; every other file is prefixed as before. Found by the first
  real-agent validation (see `e2e/validation-agent/`). **Upgrading rewrites
  every Markdown projection**: `check` reports drift on `.claude/` until you
  run `agentsdir sync` once.
- **`AGENTS.md` no longer states commands the repository does not have.** Stack
  detection tested only for the marker file and wrote the stack's usual commands
  as facts, so a Python project with no test runner declared got an `AGENTS.md`
  asserting `pytest` — worse than an empty one, because the agent believes it. A
  command is now written down only where the repository proves it: a script it
  declares, a tool it depends on, or a subcommand of the toolchain its marker
  file declares. The rest is marked to fill in.
- **A missing required argument exits `2`, not `1`.** The six commands taking a
  positional let the argument parser handle its absence: it printed the help and
  exited `1`, the code that means drift. A CI script could not tell a repository
  that had moved from a command called wrong.
- **A generator refuses before it asks.** The interview ran ahead of the
  uniqueness check and the manifest read, so retyping a taken name — or running
  a generator before `init` — cost six answers before the refusal.
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

- **The technical debt of the first architecture audit is cleared** (tasks 17
  to 23). Seven refactors, every one of them byte-for-byte neutral — 234
  fingerprints of what `init` produces, across two stacks and two pack sets,
  taken before the first and replayed after each. One directory walk instead of
  three, with the sort order made a contract because the lock fingerprints are
  fed in it. One gate for the manifest, one planner for the lock. A harness now
  declares itself once — its directory, its hook registry, its event casing and
  whether agentsdir projects files for it — instead of being named by twelve
  event definitions and six `includes("claude")` guards. Every diagnosis names
  what actually happened rather than asserting an absence it never checked.
  Every command that writes does so atomically, and has a test where a write
  fails. Coverage is measured (`npm run test:coverage`, 82% of statements) and
  still enforces nothing.


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
