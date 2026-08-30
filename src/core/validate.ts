import { pathExists } from "./fs-utils.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderOpenAiYaml, renderSkillIcon } from "./codex-metadata.js";
import {
  parseOpenSkillMarkdown,
  parseSkillMarkdown,
  readAgentFrontmatter,
  skillFrontmatterProblems,
} from "./frontmatter.js";
import {
  HOOK_REGISTRY_PATHS,
  planHookRegistrations,
  registryProblem,
  type HookHarness,
} from "./hook-registries.js";
import { extractBlock } from "./managed-blocks.js";
import { collectRuleIndexEntries, listRuleFiles } from "./rules-index.js";
import { renderRulesIndexContent } from "../templates/agents-md.js";
import { computeSkillHash, hashSkillFiles } from "./skill-hash.js";
import type { Manifest } from "./manifest.js";
import { verify } from "./projections.js";

export interface Violation {
  /** Repo-relative path of the offending file or folder. */
  path: string;
  /** Short rule identifier. */
  rule: string;
  /** What is wrong and how to fix it. */
  message: string;
  /** "info" never fails the check (agentsdir-installed content modified locally). */
  severity: "error" | "info";
}

/**
 * Runs every read-only validation, in the documented order: projections,
 * skill invariants, rules index, lock fingerprints. Never writes anything.
 */
export async function validateRepo(
  root: string,
  manifest: Manifest,
): Promise<Violation[]> {
  const violations: Violation[] = [];
  if (manifest.harness.enabled.includes("claude")) {
    violations.push(...(await validateProjections(root, manifest)));
  }
  violations.push(...(await validateSkills(root)));
  violations.push(...(await validateSubAgents(root)));
  violations.push(...(await validateRulesIndex(root)));
  violations.push(...(await validateLock(root)));
  violations.push(...(await validateHookRegistries(root, manifest)));
  return violations;
}

/**
 * Invariant 14 — sub-agent frontmatter. A `.agents/agents/*.md` without a
 * usable `name` and `description` is silently ignored by Claude Code: nothing
 * fails, the agent is simply never offered. That silence is what makes it worth
 * an invariant.
 */
async function validateSubAgents(root: string): Promise<Violation[]> {
  const agentsDir = join(root, ".agents", "agents");
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const violations: Violation[] = [];
  for (const entry of entries) {
    // same blind spot as skill folders: a symlink is neither a file nor a
    // directory to a Dirent, so it used to be skipped without a word
    if (entry.isSymbolicLink() && entry.name.endsWith(".md")) {
      violations.push({
        path: `.agents/agents/${entry.name}`,
        rule: "agent-symlinked",
        message:
          "sub-agent file is a symlink — the harness follows it and loads what it points at, which agentsdir can neither validate nor project. Move the file into the repository, or remove the link.",
        severity: "error",
      });
    }
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  for (const file of files) {
    const path = `.agents/agents/${file}`;
    let source: string;
    try {
      source = await readFile(join(agentsDir, file), "utf8");
    } catch {
      violations.push({
        path,
        rule: "agent-unreadable",
        message: "cannot be read — check the file permissions.",
        severity: "error",
      });
      continue;
    }
    const table = readAgentFrontmatter(source);
    if (table === undefined) {
      violations.push({
        path,
        rule: "agent-frontmatter",
        message:
          "has no valid YAML frontmatter block (`---` ... `---`) at the top — Claude Code ignores the file entirely, without an error.",
        severity: "error",
      });
      continue;
    }
    violations.push(...validateSubAgentFields(path, file, table));
  }
  return violations;
}

function validateSubAgentFields(
  path: string,
  file: string,
  table: Record<string, unknown>,
): Violation[] {
  const violations: Violation[] = [];
  const name = typeof table["name"] === "string" ? table["name"].trim() : "";
  const description =
    typeof table["description"] === "string" ? table["description"].trim() : "";
  if (name === "") {
    violations.push({
      path,
      rule: "agent-frontmatter",
      message:
        "frontmatter `name` is missing or empty — Claude Code ignores the file entirely, without an error.",
      severity: "error",
    });
  } else if (!NAME_SPEC.test(name)) {
    violations.push({
      path,
      rule: "agent-name-spec",
      message: `agent name "${name}" must be 1 to 64 characters of a-z, 0-9 and -, without a leading or trailing dash.`,
      severity: "error",
    });
  } else if (name !== file.slice(0, -".md".length)) {
    violations.push({
      path,
      rule: "agent-name-identity",
      message: `frontmatter \`name\` is "${name}" but the file is "${file}" — they must be identical (no alias).`,
      severity: "error",
    });
  }
  if (description === "") {
    violations.push({
      path,
      rule: "agent-frontmatter",
      message:
        "frontmatter `description` is missing or empty — it is what the harness matches to decide when to delegate, so the agent is never offered without it.",
      severity: "error",
    });
  }
  return violations;
}

async function validateProjections(
  root: string,
  manifest: Manifest,
): Promise<Violation[]> {
  const drifts = await verify(root, {
    mode: manifest.projections.mode,
    hashes: manifest.projections.hashes,
  });
  return drifts.map((drift) => ({
    path: drift.path,
    rule: `projection-${drift.kind}`,
    message: drift.detail,
    severity: "error" as const,
  }));
}

/** Agent Skills name spec, shared with the `add` generators. */
export const NAME_SPEC = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const WRITE_TOOL = /^(\*$|Write|Edit|NotebookEdit|Bash)/;

/** Check's validation pass on one skill folder; `add skill` runs it before concluding. */
export async function validateSkillFolder(
  root: string,
  folder: string,
): Promise<Violation[]> {
  return validateSkill(root, join(root, ".agents", "skills"), folder);
}

async function validateSkills(root: string): Promise<Violation[]> {
  const skillsDir = join(root, ".agents", "skills");
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const violations: Violation[] = [];
  for (const entry of entries) {
    // a Dirent for a symlink answers false to isDirectory(), so a linked skill
    // folder used to be skipped in silence — while the harness follows the link
    // and loads the SKILL.md at the other end, unvalidated
    if (entry.isSymbolicLink()) {
      violations.push({
        path: `.agents/skills/${entry.name}`,
        rule: "skill-symlinked",
        message:
          "skill folder is a symlink — the harness follows it and loads what it points at, which agentsdir can neither validate nor project. Move the skill into the repository, or remove the link.",
        severity: "error",
      });
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    violations.push(...(await validateSkill(root, skillsDir, entry.name)));
  }
  return violations;
}

async function validateSkill(
  root: string,
  skillsDir: string,
  folder: string,
): Promise<Violation[]> {
  const relSkill = `.agents/skills/${folder}`;
  const skillPath = `${relSkill}/SKILL.md`;
  let source: string;
  try {
    source = await readFile(join(skillsDir, folder, "SKILL.md"), "utf8");
  } catch (error) {
    // absent and unreadable call for opposite fixes, so say which one it is:
    // "write it or delete the folder" is bad advice for a file that is there
    const code = (error as NodeJS.ErrnoException).code;
    return [
      code === "ENOENT"
        ? {
            path: relSkill,
            rule: "skill-md-missing",
            message:
              "skill folder has no SKILL.md — every skill folder needs one; write it or delete the folder.",
            severity: "error",
          }
        : {
            path: skillPath,
            rule: "skill-md-unreadable",
            message: `SKILL.md cannot be read (${code ?? "unknown error"}) — fix its permissions or restore it; the file is there.`,
            severity: "error",
          },
    ];
  }
  let open;
  try {
    open = parseOpenSkillMarkdown(source);
  } catch (error) {
    return [
      {
        path: skillPath,
        rule: "skill-frontmatter",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
      },
    ];
  }
  // a skill without any catalogue field and without generated artifacts was
  // installed by another tool (npx skills, hand-written to the open spec):
  // hold it to the open Agent Skills spec only, never to the catalogue
  const managed =
    open.catalogue ||
    (await pathExists(join(skillsDir, folder, "agents", "openai.yaml"))) ||
    (await pathExists(join(skillsDir, folder, "assets", "icon.svg")));
  if (!managed) {
    return validateOpenSkill(open.frontmatter.name, folder, skillPath);
  }
  let parsed;
  try {
    parsed = parseSkillMarkdown(source);
  } catch {
    // report every bad field at once, and the root identity invariant first:
    // a wrong `name` makes `default-prompt` fail too, and fixing the symptom
    // before the cause is exactly the loop this used to send the user around
    const identity = validateSkillNameIdentity(
      open.frontmatter.name,
      folder,
      skillPath,
    );
    return [
      ...identity,
      ...skillFrontmatterProblems(source).map((message) => ({
        path: skillPath,
        rule: "skill-frontmatter",
        message,
        severity: "error" as const,
      })),
    ];
  }
  const violations: Violation[] = [];
  const frontmatter = parsed.frontmatter;
  violations.push(
    ...validateSkillNameIdentity(frontmatter.name, folder, skillPath),
  );
  if (!NAME_SPEC.test(frontmatter.name)) {
    violations.push({
      path: skillPath,
      rule: "skill-name-spec",
      message: `skill name "${frontmatter.name}" must be 1 to 64 characters of a-z, 0-9 and -, without a leading or trailing dash.`,
      severity: "error",
    });
  }
  if (frontmatter.implicit && frontmatter.disableModelInvocation === true) {
    violations.push({
      path: skillPath,
      rule: "skill-invocation-parity",
      message:
        "`implicit: true` requires removing `disable-model-invocation` — the invocation switches must express the same decision on every harness.",
      severity: "error",
    });
  }
  if (!frontmatter.implicit && frontmatter.disableModelInvocation !== true) {
    violations.push({
      path: skillPath,
      rule: "skill-invocation-parity",
      message:
        "an explicit skill must set `disable-model-invocation: true` (parity with `allow_implicit_invocation: false` on Codex).",
      severity: "error",
    });
  }
  if (frontmatter.implicit) {
    // `allowed-tools` is optional, and its absence means "no restriction" —
    // every tool, writes included. Testing only the declared list therefore let
    // the dangerous case through: an implicit skill free to write.
    const declared = frontmatter.allowedTools;
    if (declared === undefined || declared.length === 0) {
      violations.push({
        path: skillPath,
        rule: "skill-implicit-read-only",
        message:
          "an implicit skill must be read-only, but declares no `allowed-tools` — an absent list means no restriction at all. List the read-only tools it needs, or make the skill explicit.",
        severity: "error",
      });
    } else if (declared.some((tool) => WRITE_TOOL.test(tool))) {
      violations.push({
        path: skillPath,
        rule: "skill-implicit-read-only",
        message:
          "an implicit skill must be read-only, but `allowed-tools` declares write-capable tools (Write/Edit/NotebookEdit/Bash or *) — make the skill explicit or drop those tools.",
        severity: "error",
      });
    }
  }
  const significantLines = parsed.body
    .split("\n")
    .filter((line) => line.trim() !== "").length;
  if (significantLines < 12) {
    violations.push({
      path: skillPath,
      rule: "skill-body-depth",
      message: `body has ${significantLines} significant lines; at least 12 are required — flesh out the purpose, procedure and verification.`,
      severity: "error",
    });
  }
  if (significantLines > 500) {
    violations.push({
      path: skillPath,
      rule: "skill-body-depth",
      message: `body has ${significantLines} significant lines; keep it under 500 and move the depth into references/.`,
      severity: "error",
    });
  }
  for (const ref of referencedPaths(parsed.body)) {
    const inSkill = await pathExists(
      join(skillsDir, folder, ...ref.split("/")),
    );
    const atRoot = await pathExists(join(root, ...ref.split("/")));
    if (!inSkill && !atRoot) {
      violations.push({
        path: skillPath,
        rule: "skill-missing-reference",
        message: `references "${ref}" which exists neither in the skill folder nor at the repo root — create the file or fix the mention.`,
        severity: "error",
      });
    }
  }
  violations.push(
    ...(await compareArtifact(
      root,
      relSkill,
      "agents/openai.yaml",
      renderOpenAiYaml(frontmatter),
    )),
  );
  try {
    violations.push(
      ...(await compareArtifact(
        root,
        relSkill,
        "assets/icon.svg",
        renderSkillIcon(frontmatter),
      )),
    );
  } catch (error) {
    violations.push({
      path: skillPath,
      rule: "skill-unknown-icon",
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
    });
  }
  return violations;
}

/** The root invariant: the folder name and the frontmatter name are the same. */
function validateSkillNameIdentity(
  name: string,
  folder: string,
  skillPath: string,
): Violation[] {
  return name === folder
    ? []
    : [
        {
          path: skillPath,
          rule: "skill-name-identity",
          message: `frontmatter \`name\` is "${name}" but the folder is "${folder}" — they must be identical (no alias).`,
          severity: "error",
        },
      ];
}

/** Open-spec invariants only: folder identity and the shared name grammar. */
function validateOpenSkill(
  name: string,
  folder: string,
  skillPath: string,
): Violation[] {
  const violations: Violation[] = [];
  if (name !== folder) {
    violations.push({
      path: skillPath,
      rule: "skill-name-identity",
      message: `frontmatter \`name\` is "${name}" but the folder is "${folder}" — they must be identical (no alias).`,
      severity: "error",
    });
  }
  if (!NAME_SPEC.test(name)) {
    violations.push({
      path: skillPath,
      rule: "skill-name-spec",
      message: `skill name "${name}" must be 1 to 64 characters of a-z, 0-9 and -, without a leading or trailing dash.`,
      severity: "error",
    });
  }
  violations.push({
    path: skillPath,
    rule: "skill-external",
    message:
      "outside the agentsdir catalogue (no catalogue field, no generated artifact) — validated against the open Agent Skills spec only; `sync` leaves it untouched.",
    severity: "info",
  });
  return violations;
}

async function compareArtifact(
  root: string,
  relSkill: string,
  relArtifact: string,
  expected: string,
): Promise<Violation[]> {
  const path = `${relSkill}/${relArtifact}`;
  let current: string;
  try {
    current = await readFile(join(root, ...path.split("/")), "utf8");
  } catch {
    return [
      {
        path,
        rule: "codex-artifact-missing",
        message: "generated Codex artifact is missing — run `agentsdir sync`.",
        severity: "error",
      },
    ];
  }
  if (current !== expected) {
    return [
      {
        path,
        rule: "codex-artifact-drift",
        message:
          "differs from the deterministic render of the frontmatter — run `agentsdir sync` and never edit generated files by hand.",
        severity: "error",
      },
    ];
  }
  return [];
}

async function validateRulesIndex(root: string): Promise<Violation[]> {
  let agentsMd: string;
  try {
    agentsMd = await readFile(join(root, "AGENTS.md"), "utf8");
  } catch {
    return [
      {
        path: "AGENTS.md",
        rule: "agents-md-missing",
        message: "AGENTS.md is missing — run `agentsdir init`.",
        severity: "error",
      },
    ];
  }
  const block = extractBlock(agentsMd, "rules-index", "html");
  if (block === undefined) {
    return [
      {
        path: "AGENTS.md",
        rule: "rules-index-missing",
        message:
          "managed block `rules-index` is missing — run `agentsdir sync`.",
        severity: "error",
      },
    ];
  }
  const ruleFiles = await listRuleFiles(root);
  const violations: Violation[] = [];
  for (const file of ruleFiles) {
    if (!block.includes(`.agents/rules/${file}`)) {
      violations.push({
        path: `.agents/rules/${file}`,
        rule: "rules-index-out-of-sync",
        message:
          "rule is not listed in the `rules-index` block of AGENTS.md — run `agentsdir sync`.",
        severity: "error",
      });
    }
  }
  const mentioned = new Set(
    block.match(/\.agents\/rules\/[a-z0-9-]+\.md/g) ?? [],
  );
  for (const entry of mentioned) {
    const file = entry.slice(".agents/rules/".length);
    if (!ruleFiles.includes(file)) {
      violations.push({
        path: entry,
        rule: "rules-index-out-of-sync",
        message:
          "index entry points to a missing rule — restore the file or run `agentsdir sync`.",
        severity: "error",
      });
    }
  }
  if (violations.length > 0) {
    return violations;
  }
  // every path lines up; the text may still not. `sync` regenerates
  // "path — when to read it" from the first line of each rule, so a rule whose
  // purpose changed kept its stale description in AGENTS.md indefinitely —
  // checking for the presence of paths could never see it.
  const expected = renderRulesIndexContent(await collectRuleIndexEntries(root));
  if (block.trim() !== expected.trim()) {
    violations.push({
      path: "AGENTS.md",
      rule: "rules-index-out-of-sync",
      message:
        "the `rules-index` block lists the right rules but not the right text — a rule's first line changed since the last sync; run `agentsdir sync`.",
      severity: "error",
    });
  }
  return violations;
}

async function validateLock(root: string): Promise<Violation[]> {
  let raw: string;
  try {
    raw = await readFile(join(root, "skills-lock.json"), "utf8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [
      {
        path: "skills-lock.json",
        rule: "lock-invalid",
        message: "not valid JSON — restore it from git history.",
        severity: "error",
      },
    ];
  }
  const skills = (data as { skills?: unknown }).skills;
  if (typeof skills !== "object" || skills === null || Array.isArray(skills)) {
    return [
      {
        path: "skills-lock.json",
        rule: "lock-invalid",
        message: "missing `skills` table — restore it from git history.",
        severity: "error",
      },
    ];
  }
  const violations: Violation[] = [];
  const entries = Object.entries(skills as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const [name, entryRaw] of entries) {
    const entry = (entryRaw ?? {}) as Record<string, unknown>;
    const recorded = entry["computedHash"];
    const relSkill = `.agents/skills/${name}`;
    // the key becomes a path segment: a lock from a cloned repo could otherwise
    // point the reader at a directory outside the repository
    if (!NAME_SPEC.test(name)) {
      violations.push({
        path: "skills-lock.json",
        rule: "lock-invalid",
        message: `lock entry "${name}" is not a valid skill name (1 to 64 characters of a-z, 0-9 and -) — a lock key is a folder name, never a path.`,
        severity: "error",
      });
      continue;
    }
    if (typeof recorded !== "string") {
      violations.push({
        path: relSkill,
        rule: "lock-invalid",
        message: `lock entry "${name}" has no \`computedHash\` string — restore skills-lock.json from git history.`,
        severity: "error",
      });
      continue;
    }
    let actual: string;
    try {
      actual = await computeSkillHash(join(root, ".agents", "skills", name));
    } catch {
      violations.push({
        path: relSkill,
        rule: "lock-skill-missing",
        message:
          "locked skill folder is missing — restore it or remove the lock entry.",
        severity: "error",
      });
      continue;
    }
    if (actual === recorded) {
      continue;
    }
    if (entry["sourceType"] === "agentsdir") {
      violations.push({
        path: relSkill,
        rule: "lock-local-change",
        message:
          "agentsdir-installed content modified locally — kept as is; `agentsdir update` will propose a merge when available.",
        severity: "info",
      });
    } else {
      violations.push({
        path: relSkill,
        rule: "lock-drift",
        message:
          "sha256 differs from skills-lock.json — the skill was overwritten or edited without updating the lock; re-vendor it or update the lock consciously.",
        severity: "error",
      });
    }
  }
  return violations;
}

function referencedPaths(body: string): string[] {
  const matches =
    body.match(/(?:references|scripts|steps)\/[A-Za-z0-9_\-./]+/g) ?? [];
  return [
    ...new Set(matches.map((match) => match.replace(/[.,)`]+$/, ""))),
  ].filter(
    // a mention is a reference inside the skill, never a way to probe the disk
    // outside it: a `..` segment is dropped rather than resolved
    (path) => path !== "" && !path.split("/").includes(".."),
  );
}

// re-exported so `check` keeps a single entry point for its callers
export { computeSkillHash, hashSkillFiles };

/**
 * The hook registries of the enabled harnesses, held to the same contract
 * `sync` applies. Without this, `check` passed on a repo whose registries
 * `sync` refuses — a green CI on a repository that cannot be synced.
 */
async function validateHookRegistries(
  root: string,
  manifest: Manifest,
): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const harness of manifest.harness.enabled) {
    const path = HOOK_REGISTRY_PATHS[harness as HookHarness];
    if (path === undefined) {
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(join(root, ...path.split("/")), "utf8");
    } catch {
      continue; // no registry yet is the normal state
    }
    const problem = registryProblem(raw, path);
    if (problem !== undefined) {
      violations.push({
        path,
        rule: "hook-registry-invalid",
        message: problem,
        severity: "error",
      });
    }
  }
  // a malformed registry cannot be planned against: report the shape first and
  // let `sync` be the one to rewrite it
  if (violations.length > 0) {
    return violations;
  }
  return [...violations, ...(await compareHookRegistrations(root, manifest))];
}

/**
 * Compares the registrations on disk to the ones the scripts of `.agents/hooks/`
 * imply — the very plan `sync` applies. Checking only the shape of the file let
 * both directions of drift through: a script added without a `sync` was
 * registered nowhere, so no harness ever ran it and CI stayed green; a deleted
 * script left registrations the three harnesses would still try to execute.
 */
async function compareHookRegistrations(
  root: string,
  manifest: Manifest,
): Promise<Violation[]> {
  let plans;
  try {
    plans = await planHookRegistrations(root, manifest.harness.enabled);
  } catch {
    // an unreadable registry: already the business of the shape pass above and
    // of `sync`, which refuses rather than overwriting what it cannot read
    return [];
  }
  return plans
    .filter((plan) => plan.action !== "ok")
    .map((plan) => ({
      path: plan.path,
      rule: "hook-registration-drift",
      message:
        plan.action === "created"
          ? "hook scripts in .agents/hooks/ are registered nowhere — no harness will ever run them; run `agentsdir sync`."
          : "registrations differ from the scripts in .agents/hooks/ — a script was added, renamed or deleted without a sync; run `agentsdir sync`.",
      severity: "error" as const,
    }));
}
