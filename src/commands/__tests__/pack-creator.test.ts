import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../../core/frontmatter.js";
import { FILTER_QUESTION } from "../../packs/creator.js";
import { runCheck } from "../check.js";
import { runInit, type InitAnswers } from "../init.js";
import { runPackAdd, runPackRemove } from "../pack.js";
import { runSync } from "../sync.js";

const META_SKILLS = [
  "create-skill",
  "create-hook",
  "create-rule",
  "create-agent",
] as const;

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentsdir-creator-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  tempDirs = [];
});

function initAnswers(packs: string[] = ["core"]): InitAnswers {
  return {
    productName: "demo",
    description: "A demo product.",
    commands: { test: "npm test" },
    harnesses: ["claude", "codex", "cursor"],
    packs,
    mode: "copy",
    stacks: [],
  };
}

async function initializedRepo(packs?: string[]): Promise<string> {
  const dir = await makeTempDir();
  await runInit(dir, initAnswers(packs), { dryRun: false });
  return dir;
}

async function repoWithCreator(): Promise<string> {
  const dir = await initializedRepo();
  await runPackAdd(dir, "creator", { dryRun: false });
  return dir;
}

async function metaSkillBody(root: string, name: string): Promise<string> {
  const source = await readFile(
    join(root, ".agents", "skills", name, "SKILL.md"),
    "utf8",
  );
  return parseSkillMarkdown(source).body;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("15 - pack creator", () => {
  it("Given an initialized repo, When pack add creator runs, Then the four meta-skills are installed complete, locked as agentsdir, and check reports zero violations", async () => {
    const dir = await repoWithCreator();
    for (const name of META_SKILLS) {
      for (const rel of [
        "SKILL.md",
        "references/rubrique.md",
        "references/interview.md",
        "agents/openai.yaml",
        "assets/icon.svg",
      ]) {
        expect(
          await pathExists(
            join(dir, ".agents", "skills", name, ...rel.split("/")),
          ),
          `${name}/${rel} missing`,
        ).toBe(true);
      }
    }
    const lock = JSON.parse(
      await readFile(join(dir, "skills-lock.json"), "utf8"),
    ) as { skills: Record<string, Record<string, unknown>> };
    for (const name of META_SKILLS) {
      expect(lock.skills[name]?.["sourceType"]).toBe("agentsdir");
      expect(lock.skills[name]?.["computedHash"]).toMatch(/^[0-9a-f]{64}$/);
    }
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
    expect(check.exitCode).toBe(0);
  });

  it("Given each meta-skill body, When inspected, Then it applies the six-step protocol in order with the verbatim filter question", async () => {
    const dir = await repoWithCreator();
    for (const name of META_SKILLS) {
      const body = await metaSkillBody(dir, name);
      const steps = [
        "## 1. Inventory",
        "## 2. Targeted interview",
        "## 3. Routing",
        "## 4. Draft, then critique",
        "## 5. Generate, then write",
        "## 6. Mechanical validation",
      ];
      let cursor = -1;
      for (const step of steps) {
        const index = body.indexOf(step);
        expect(
          index,
          `${name}: "${step}" missing or out of order`,
        ).toBeGreaterThan(cursor);
        cursor = index;
      }
      expect(body).toContain("references/interview.md");
      expect(body).toContain("references/rubrique.md");
      expect(body, `${name}: filter question not verbatim`).toContain(
        FILTER_QUESTION,
      );
      expect(body).toContain("agentsdir add");
      expect(body).toContain("agentsdir check");
    }
  });

  it("Given each rubric, When inspected, Then mechanical ▣ criteria are distinguished from critique criteria", async () => {
    const dir = await repoWithCreator();
    for (const name of META_SKILLS) {
      const rubric = await readFile(
        join(dir, ".agents", "skills", name, "references", "rubrique.md"),
        "utf8",
      );
      expect(rubric, `${name}: no ▣ marker`).toContain("▣");
      expect(rubric, `${name}: no critique section`).toContain("Critique");
      const interview = await readFile(
        join(dir, ".agents", "skills", name, "references", "interview.md"),
        "utf8",
      );
      // one level of indirection only: references never point to more files
      expect(rubric).not.toMatch(/references\/[a-z]/);
      expect(interview).not.toMatch(/references\/[a-z]/);
    }
  });

  it("Given create-skill, When inspected, Then it imposes the trigger test and the third-person description with the user's keywords", async () => {
    const dir = await repoWithCreator();
    const body = await metaSkillBody(dir, "create-skill");
    expect(body).toContain("at least 3 user phrases that MUST trigger");
    expect(body).toContain("at least 2 near-miss phrases that must NOT");
    expect(body).toContain("third person");
    expect(body).toContain("keywords");
    expect(body).toContain('never "Helps with…"');
  });

  it("Given create-hook, When inspected, Then it routes prevent/react, asks fail-open or fail-closed, and imperatively refuses hard security bans", async () => {
    const dir = await repoWithCreator();
    const body = await metaSkillBody(dir, "create-hook");
    expect(body).toContain("PREVENT or REACT?");
    expect(body).toContain("exit 2");
    expect(body).toContain("PostToolUse");
    expect(body).toContain("fail-open or fail-closed");
    expect(body).toContain("do NOT create the hook");
    expect(body).toContain("permission settings");
    expect(body).toContain("NOT a security boundary");
  });

  it("Given the meta-skills themselves, When parsed, Then they respect every convention: explicit invocation, body under 500 lines, one level of references", async () => {
    const dir = await repoWithCreator();
    for (const name of META_SKILLS) {
      const source = await readFile(
        join(dir, ".agents", "skills", name, "SKILL.md"),
        "utf8",
      );
      const { frontmatter, body } = parseSkillMarkdown(source);
      expect(frontmatter.disableModelInvocation).toBe(true);
      expect(frontmatter.implicit).toBe(false);
      expect(frontmatter.defaultPrompt).toContain(`$${name}`);
      const significant = body
        .split("\n")
        .filter((line) => line.trim() !== "").length;
      expect(significant).toBeGreaterThanOrEqual(12);
      expect(significant).toBeLessThan(500);
    }
  });

  it("Given the pack just installed, When sync dry-runs, Then artifacts and lock are already in step (same bytes as pack add)", async () => {
    const dir = await repoWithCreator();
    const sync = await runSync(dir, { dryRun: true });
    expect(sync.exitCode).toBe(0);
    for (const name of META_SKILLS) {
      for (const rel of ["agents/openai.yaml", "assets/icon.svg"]) {
        const change = sync.changes.find(
          (entry) => entry.path === `.agents/skills/${name}/${rel}`,
        );
        expect(change?.action).toBe("ok");
      }
    }
    expect(
      sync.changes.find((entry) => entry.path === "skills-lock.json")?.action,
    ).toBe("ok");
  });

  it("Given init with the default packs (core + creator), When it completes, Then the meta-skills are installed and check is clean", async () => {
    const dir = await initializedRepo(["core", "creator"]);
    for (const name of META_SKILLS) {
      expect(
        await pathExists(join(dir, ".agents", "skills", name, "SKILL.md")),
      ).toBe(true);
    }
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
  });

  it("Given scripted interview answers, When the create-skill procedure is walked mechanically, Then the produced skill passes check on the first try", async () => {
    const dir = await repoWithCreator();
    // the scripted answers an agent would have collected at step 2
    const scripted = {
      name: "release-notes",
      keywords: ["release notes", "changelog entry", "version summary"],
      triggers: [
        "write the release notes for v2",
        "draft the changelog entry for this release",
        "summarize what shipped this version",
      ],
      nonTriggers: [
        "write a blog post about the release party",
        "bump the version number",
      ],
    };
    // step 5 of the meta-skill: generate the skeleton first…
    const { runAddSkill } = await import("../add-skill.js");
    const { defaultSkillAnswers } = await import("../../templates/skill.js");
    await runAddSkill(dir, defaultSkillAnswers(scripted.name, false), {
      dryRun: false,
    });
    // …then replace the content as the meta-skill prescribes: third-person
    // description carrying the user's keywords, trigger test recorded,
    // procedure and verification sections
    const skillMd = [
      "---",
      `name: ${scripted.name}`,
      `description: "Writes the release notes of a version from the merged changes. Use when the user asks for ${scripted.keywords.join(", ")}."`,
      "disable-model-invocation: true",
      'display-name: "Release Notes"',
      'short-description: "Writes the release notes of a version"',
      'color: "#1F4E8C"',
      "icon: file-text",
      `default-prompt: "Use $${scripted.name} to write the release notes of the current version."`,
      "implicit: false",
      "---",
      "",
      "# Release Notes",
      "",
      "## Objective",
      "",
      "Write the release notes of the version being shipped, grouped by",
      "Added / Changed / Fixed / Removed, from the actually merged changes.",
      "",
      "## Trigger test",
      "",
      ...scripted.triggers.map((phrase) => `- MUST trigger: "${phrase}"`),
      ...scripted.nonTriggers.map(
        (phrase) => `- must NOT trigger: "${phrase}"`,
      ),
      "",
      "## Procedure",
      "",
      "1. List the merged changes since the last tag.",
      "2. Group them by Added / Changed / Fixed / Removed.",
      "3. Write each entry for humans: what changed and why it matters.",
      "",
      "## Verification",
      "",
      "- Every merged change appears in exactly one group.",
      "- No entry restates a commit subject line verbatim.",
      "",
    ].join("\n");
    await writeFile(
      join(dir, ".agents", "skills", scripted.name, "SKILL.md"),
      skillMd,
      "utf8",
    );
    // step 5 continued: sync regenerates the Codex artifacts…
    const sync = await runSync(dir, { dryRun: false });
    expect(sync.exitCode).toBe(0);
    // …and step 6: mechanical validation passes on the first try
    const check = await runCheck(dir);
    expect(check.violations).toEqual([]);
    expect(check.exitCode).toBe(0);
  });

  it("Given creator co-installed with verification, When creator is removed, Then the lock keeps the verify entry — and an empty lock is deleted otherwise", async () => {
    const dir = await initializedRepo();
    await runPackAdd(dir, "creator", { dryRun: false });
    await runPackAdd(dir, "verification", { dryRun: false });
    await runPackRemove(dir, "creator", { force: false, dryRun: false });
    const lock = JSON.parse(
      await readFile(join(dir, "skills-lock.json"), "utf8"),
    ) as { skills: Record<string, unknown> };
    expect(Object.keys(lock.skills)).toEqual(["verify"]);
    for (const name of META_SKILLS) {
      expect(await pathExists(join(dir, ".agents", "skills", name))).toBe(
        false,
      );
    }
    expect((await runCheck(dir)).violations).toEqual([]);
    // second path: creator alone → removing it empties and deletes the lock
    const solo = await repoWithCreator();
    await runPackRemove(solo, "creator", { force: false, dryRun: false });
    expect(await pathExists(join(solo, "skills-lock.json"))).toBe(false);
    expect((await runCheck(solo)).violations).toEqual([]);
  });
});
