import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  citeSource,
  CONVENTION_NORMS,
  NORMS,
  renderConventionsReference,
} from "../../core/conventions-dates.js";
import { parseSkillMarkdown } from "../../core/frontmatter.js";
import { creatorPack } from "../../packs/creator.js";
import { FORM_SKILL } from "../../packs/creator-form.js";
import { initAnswers, makeTempDir } from "../../test-support/index.js";
import { runCheck } from "../check.js";
import { runInit } from "../init.js";

const DIR = `.agents/skills/${FORM_SKILL}`;

function packFile(path: string): string {
  const file = creatorPack().files.find((entry) => entry.path === path);
  expect(file, `${path} missing from the creator pack`).toBeDefined();
  return file?.content ?? "";
}

/**
 * Criterion: "a meta-skill of the `creator` pack confronts the form of the
 * repository's configuration with the dated norms and produces argued
 * proposals, each quoting the norm, its source and its date."
 */
describe("Given the creator pack", () => {
  it("When it is rendered, Then it ships a meta-skill that judges form, with the norms beside it", () => {
    const pack = creatorPack();
    expect(pack.skills).toContain(FORM_SKILL);
    for (const file of [
      `${DIR}/SKILL.md`,
      `${DIR}/references/conventions.md`,
      `${DIR}/references/rubrique.md`,
      `${DIR}/references/interview.md`,
    ]) {
      expect(pack.files.map((entry) => entry.path)).toContain(file);
    }
  });

  it("When the norms travel with the skill, Then they are the shipped table, not a copy written by hand", () => {
    expect(packFile(`${DIR}/references/conventions.md`)).toBe(
      renderConventionsReference(),
    );
  });

  it("When the skill is asked for a proposal, Then it requires the norm, its source and its date on every one", () => {
    const body = packFile(`${DIR}/SKILL.md`);
    expect(body).toContain("references/conventions.md");
    expect(body).toContain("**Its source and the date it was read**");
    expect(body).toMatch(/without these three is not a proposal/);
    // and it must forbid the shortcut that would make all of it worthless
    expect(body).toContain("Never from memory");
  });

  it("When the report is written, Then the four diagnostics are named apart, each with its own command", () => {
    const body = packFile(`${DIR}/SKILL.md`);
    for (const marker of [
      "**drifted**",
      "agentsdir check",
      "**serve**",
      "$review-usage",
      "**cost**",
      "agentsdir doctor --json",
      "**form**",
    ]) {
      expect(body, marker).toContain(marker);
    }
    expect(body).toContain("Never mix two rows");
  });

  it("When a proposal is accepted, Then the skill still applies nothing itself", () => {
    const body = packFile(`${DIR}/SKILL.md`);
    expect(body).toContain("**Apply nothing.**");
    expect(body).toContain("the team decides");
    expect(packFile(`${DIR}/references/rubrique.md`)).toContain(
      "because it has applied",
    );
  });

  it("When the skill runs, Then nothing it produces leaves the repository", () => {
    const body = packFile(`${DIR}/SKILL.md`);
    expect(body).toContain(".agents/output/form/");
    // the redirection would fail on a fresh repo: nothing else creates it
    expect(body).toContain("mkdir -p .agents/output/form");
    expect(body).toContain("managed `.gitignore` block");
    expect(body).toContain("no upload, no issue, no paste into a third-party");
    expect(body).toContain("no query to a registry");
  });

  it("When the norms are bumped, Then the shipped reference moves with them", () => {
    const rendered = packFile(`${DIR}/references/conventions.md`);
    for (const norm of CONVENTION_NORMS) {
      expect(rendered, norm.id).toContain(citeSource(norm.source));
    }
    expect(rendered).toContain(
      `${NORMS["skill-description-length"].bound.value} characters`,
    );
  });

  it("When the skill is validated as a catalogue entry, Then its frontmatter holds every field check requires", () => {
    const parsed = parseSkillMarkdown(packFile(`${DIR}/SKILL.md`));
    expect(parsed.frontmatter.name).toBe(FORM_SKILL);
    expect(parsed.frontmatter.defaultPrompt).toContain(`$${FORM_SKILL}`);
    expect(parsed.frontmatter.implicit).toBe(false);
    expect(
      parsed.body.split("\n").filter((line) => line.trim() !== "").length,
    ).toBeGreaterThanOrEqual(12);
  });
});

describe("Given a repository the CLI has just initialized", () => {
  it("When check runs, Then the form meta-skill it installed passes every invariant", async () => {
    const dir = await makeTempDir("pack-creator-form");
    await runInit(dir, initAnswers({ packs: ["core", "creator"] }), {
      dryRun: false,
    });
    const result = await runCheck(dir);
    expect(result.exitCode).toBe(0);
    // and the reference really is on disk, where the skill tells the agent to read it
    const onDisk = await readFile(
      join(dir, ...`${DIR}/references/conventions.md`.split("/")),
      "utf8",
    );
    expect(onDisk).toBe(renderConventionsReference());
  });
});
