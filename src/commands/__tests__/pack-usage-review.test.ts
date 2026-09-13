import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { USAGE_JOURNAL_DIR } from "../../core/usage-journal.js";
import { REVIEW_SKILL } from "../../packs/usage-review.js";
import {
  initAnswers,
  makeTempDir,
  pathExists,
} from "../../test-support/index.js";
import { runAddRule } from "../add-rule.js";
import { runCheck } from "../check.js";
import { runDoctor } from "../doctor.js";
import { runInit } from "../init.js";
import { runPackAdd, runPackRemove } from "../pack.js";

const execFileAsync = promisify(execFile);

/**
 * Task 30 — the review stage of the `usage` pack. The script counts and the
 * meta-skill judges, so everything asserted here is arithmetic and wording:
 * the volume a conclusion rests on, the refusal below it, the three buckets a
 * rule can land in, and the vocabulary that keeps relevance from being read as
 * usage.
 */

const SCRIPT = [".agents", "skills", REVIEW_SKILL, "scripts", "summarize.mjs"];

interface Row {
  name: string;
  /** Sub-agent rows carry the file the name was read from; skill rows do not. */
  file?: string;
  occurrences: number;
  sessions: number;
  lastSeen: string | null;
  perSession: number | null;
  perInvocation: number | null;
}

interface RuleRow {
  file: string;
  globs: string[];
  matches: number;
  sessions: number;
  lastSeen: string | null;
  bucket: "relevant" | "never-relevant" | "cannot-say";
  perSession: number | null;
  perInvocation: number | null;
}

interface Digest {
  volume: {
    sessions: number;
    days: number;
    lines: number;
    files: number;
    first: string | null;
    last: string | null;
    threshold: { sessions: number; days: number };
    conclusive: boolean;
  };
  skills: Row[];
  agents: Row[];
  rules: RuleRow[];
  limits: {
    delegations: number;
    unnamedDelegations: number;
    toolCalls: number;
    toolCallsWithoutPath: number;
    excludeGlobs: string[];
    collectionEnabled: boolean;
    retentionDays: number;
    cost: "measured" | "not-measured";
  };
}

/**
 * A repo with several skills installed, which is the only situation a usage
 * review is for: with a single skill there is nothing to compare and nothing
 * that could be missing from the journal.
 */
async function repoWithUsage(): Promise<string> {
  const dir = await makeTempDir("usage-review");
  await execFileAsync("git", ["-C", dir, "init"]);
  await runInit(dir, initAnswers({ packs: ["core", "creator"] }), {
    dryRun: false,
  });
  await runPackAdd(dir, "usage", { dryRun: false });
  return dir;
}

interface JournalShape {
  /** Distinct days written, one file each, counting back from a fixed date. */
  days: number;
  /** Distinct sessions per day. */
  sessionsPerDay: number;
  /** Skill invocations per session. */
  skills?: string[];
  /** Repo-relative paths touched per session. */
  paths?: string[];
  /** Delegations per session, `null` for one carrying no agent name. */
  agents?: (string | null)[];
}

/**
 * A journal in the exact format of conventions.md §9: UTC timestamps, one file
 * per day whose name matches the day of its own lines, 12-hex session keys.
 */
async function writeJournal(root: string, shape: JournalShape): Promise<void> {
  const dir = join(root, ...USAGE_JOURNAL_DIR.split("/"));
  await mkdir(dir, { recursive: true });
  const start = Date.UTC(2026, 7, 3);
  for (let day = 0; day < shape.days; day += 1) {
    const date = new Date(start + day * 86400000);
    const iso = date.toISOString().slice(0, 10);
    const lines: string[] = [];
    for (let index = 0; index < shape.sessionsPerDay; index += 1) {
      const session = createHash("sha256")
        .update(`${iso}-${index}`)
        .digest("hex")
        .slice(0, 12);
      let minute = 0;
      const push = (entry: Record<string, unknown>): void => {
        minute += 1;
        lines.push(
          JSON.stringify({
            ts: `${iso}T09:${String(minute).padStart(2, "0")}:00.000Z`,
            event: "PreToolUse",
            tool: null,
            path: null,
            skill: null,
            agent: null,
            session,
            ...entry,
          }),
        );
      };
      push({ event: "SessionStart" });
      for (const skill of shape.skills ?? []) {
        push({ tool: "Skill", skill });
      }
      for (const path of shape.paths ?? []) {
        push({ tool: "Read", path });
      }
      for (const agent of shape.agents ?? []) {
        push({ event: "SubagentStart", agent });
      }
      push({ event: "SessionEnd" });
    }
    await writeFile(join(dir, `usage-${iso}.jsonl`), `${lines.join("\n")}\n`);
  }
}

/** Runs the installed script the way the skill does. */
async function summarize(
  root: string,
  options: { json?: boolean; doctor?: boolean } = {},
): Promise<string> {
  const args = [join(root, ...SCRIPT)];
  if (options.json === true) {
    args.push("--json");
  }
  if (options.doctor === true) {
    const budget = await runDoctor(root);
    const file = join(root, ...USAGE_JOURNAL_DIR.split("/"), "doctor.json");
    await writeFile(
      file,
      JSON.stringify({ context: { items: budget.context?.items ?? [] } }),
      "utf8",
    );
    args.push("--doctor", file);
  }
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function digest(
  root: string,
  options: { doctor?: boolean } = {},
): Promise<Digest> {
  return JSON.parse(
    await summarize(root, { ...options, json: true }),
  ) as Digest;
}

/** A journal that clears the threshold, so absences may be concluded. */
async function conclusiveJournal(root: string): Promise<void> {
  await writeJournal(root, {
    days: 14,
    sessionsPerDay: 2,
    skills: [REVIEW_SKILL],
    paths: ["src/api/handler.ts"],
  });
}

async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(abs: string, rel: string): Promise<void> {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const next = join(abs, entry.name);
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(next, path);
      } else if (entry.isFile()) {
        files.set(
          path,
          createHash("sha256")
            .update(await readFile(next))
            .digest("hex"),
        );
      }
    }
  }
  await walk(dir, "");
  return files;
}

describe("30 - pack usage, the review stage", () => {
  it("Given the usage pack, When it is installed, Then the review skill and its script ship with it and check stays green", async () => {
    const dir = await repoWithUsage();

    expect(await pathExists(join(dir, ...SCRIPT))).toBe(true);
    expect(
      await pathExists(
        join(dir, ".agents", "skills", REVIEW_SKILL, "SKILL.md"),
      ),
    ).toBe(true);
    const check = await runCheck(dir);
    expect(
      check.violations.filter((violation) => violation.severity === "error"),
    ).toEqual([]);
    expect(check.exitCode).toBe(0);
  });

  it("Given the review script, When the allowlist is built, Then the agent may run it without a permission prompt", async () => {
    // the collectors are absent from the allowlist because the harness runs
    // them; this one is run by the agent, so its absence would be a prompt on
    // every review
    const dir = await repoWithUsage();

    const settings = await readFile(
      join(dir, ".claude", "settings.json"),
      "utf8",
    );

    expect(settings).toContain(
      `Bash(node .agents/skills/${REVIEW_SKILL}/scripts/summarize.mjs *)`,
    );
  });

  it("Given an observed repo, When the review runs, Then it separates what was used, what was never seen, and what it cannot say", async () => {
    const dir = await repoWithUsage();
    await conclusiveJournal(dir);

    const report = await summarize(dir);

    expect(report).toContain("## What was used");
    expect(report).toContain("## What was never seen");
    expect(report).toContain("## What this measure cannot say");
    const parsed = await digest(dir);
    const used = parsed.skills.find((row) => row.name === REVIEW_SKILL);
    expect(used?.occurrences).toBe(28);
    expect(
      parsed.skills.filter((row) => row.occurrences === 0).length,
    ).toBeGreaterThan(0);
    // "last seen" is what a removal proposal rests on: the most recent
    // occurrence, never the first one of the window
    expect(used?.lastSeen?.slice(0, 10)).toBe("2026-08-16");
    expect(used?.lastSeen?.slice(0, 10)).toBe(parsed.volume.last?.slice(0, 10));
    expect(parsed.volume.first?.slice(0, 10)).toBe("2026-08-03");
  });

  it("Given a rule scoped to touched files and one scoped elsewhere and one unscoped, When the review runs, Then each lands in its own bucket", async () => {
    const dir = await repoWithUsage();
    await runAddRule(
      dir,
      { name: "api", hook: "Read before the API.", paths: ["src/api/**"] },
      { dryRun: false },
    );
    await runAddRule(
      dir,
      { name: "batch", hook: "Read before the batch.", paths: ["batch/**"] },
      { dryRun: false },
    );
    await runAddRule(
      dir,
      { name: "house", hook: "Read before any code.", paths: [] },
      { dryRun: false },
    );
    // `**` has to cross directory boundaries, exactly as `add rule --paths`
    // means it: `src/**` covers `src/api/handler.ts`, two segments down
    await runAddRule(
      dir,
      { name: "deep", hook: "Read before any source.", paths: ["src/**"] },
      { dryRun: false },
    );
    await conclusiveJournal(dir);

    const rules = (await digest(dir, { doctor: true })).rules;

    const bucket = (file: string): string =>
      rules.find((rule) => rule.file === file)?.bucket ?? "missing";
    expect(bucket("api.md")).toBe("relevant");
    expect(bucket("deep.md")).toBe("relevant");

    // each rule carries its own cost, joined on its own path, with the moment
    // it is paid: an unscoped rule every session, a scoped one only when
    // relevant — a scoped rule billed per session would read as a false cost
    const items = (await runDoctor(dir)).context?.items ?? [];
    const tokensOf = (file: string): number =>
      items.find((item) => item.path === `.agents/rules/${file}`)?.tokens ?? 0;
    const house = rules.find((rule) => rule.file === "house.md");
    const api = rules.find((rule) => rule.file === "api.md");
    expect(house?.perSession).toBe(tokensOf("house.md"));
    expect(house?.perInvocation).toBe(0);
    expect(api?.perSession).toBe(0);
    expect(api?.perInvocation).toBe(tokensOf("api.md"));
    expect(tokensOf("house.md")).not.toBe(tokensOf("api.md"));

    // and the unscoped rule is named in the limits section, where it belongs:
    // silence there would leave it looking either dead or free
    const limits = (await summarize(dir)).split(
      "## What this measure cannot say",
    )[1];
    expect(limits).toContain("declare no `paths:` scope");
    expect(limits).toContain("house.md");
    expect(limits).toContain("paid at every session");
    expect(bucket("batch.md")).toBe("never-relevant");
    // an unscoped rule has no scope to meet: it is neither, and saying it is
    // "never relevant" would propose deleting a rule that applies everywhere
    expect(bucket("house.md")).toBe("cannot-say");
  });

  it("Given rules in the report, When it is rendered, Then they are spoken of as relevant and never as used or read", async () => {
    const dir = await repoWithUsage();
    await runAddRule(
      dir,
      { name: "api", hook: "Read before the API.", paths: ["src/api/**"] },
      { dryRun: false },
    );
    await conclusiveJournal(dir);

    const section = (await summarize(dir)).split("## Rule relevance")[1] ?? "";

    expect(section).toContain("relevant");
    expect(section).toContain("no hook can say whether an agent read one");
    for (const forbidden of [" used", "invoked", "unread", "never read"]) {
      expect(section.split("## What this measure cannot say")[0]).not.toContain(
        forbidden,
      );
    }
  });

  it("Given a journal below the threshold, When the review runs, Then it refuses to conclude on an absence and still reports what was used", async () => {
    const dir = await repoWithUsage();
    await writeJournal(dir, {
      days: 3,
      sessionsPerDay: 1,
      skills: [REVIEW_SKILL],
    });

    const parsed = await digest(dir);
    const report = await summarize(dir);

    expect(parsed.volume.conclusive).toBe(false);
    expect(report).toContain("**Not met**");
    expect(report).toContain("3 session(s) over 3 day(s)");
    expect(report).toContain("Not concluded");
    // the refusal is stated, not softened into a hint that something might be
    // unused — a statistic on three points is what this exists to prevent
    expect(report).toContain("**No absence is concluded below.**");
    expect(report).not.toMatch(/consider (pruning|removing)/i);
    expect(report).not.toMatch(/probably/i);
    // a presence is proved by one line: the used table survives the refusal
    expect(report).toContain(REVIEW_SKILL);
    expect(report).not.toContain("CANDIDATE for removal");
  });

  it("Given journals at each edge of the threshold, When the volume is judged, Then both conditions must be met", async () => {
    const both = await repoWithUsage();
    await writeJournal(both, { days: 14, sessionsPerDay: 2 });
    expect((await digest(both)).volume).toMatchObject({
      sessions: 28,
      days: 14,
      conclusive: true,
    });

    const tooFewSessions = await repoWithUsage();
    await writeJournal(tooFewSessions, { days: 19, sessionsPerDay: 1 });
    expect((await digest(tooFewSessions)).volume).toMatchObject({
      sessions: 19,
      days: 19,
      conclusive: false,
    });

    const tooFewDays = await repoWithUsage();
    await writeJournal(tooFewDays, { days: 13, sessionsPerDay: 4 });
    expect((await digest(tooFewDays)).volume).toMatchObject({
      sessions: 52,
      days: 13,
      conclusive: false,
    });
  });

  it("Given a removal candidate, When it is listed, Then it carries the data that motivates it", async () => {
    const dir = await repoWithUsage();
    await conclusiveJournal(dir);

    const report = await summarize(dir, { doctor: true });

    const never = (report.split("## What was never seen")[1] ?? "").split(
      "## Rule relevance",
    )[0];
    expect(never).toContain("Never seen over 28 sessions and 14 days");
    expect(never).toContain("CANDIDATE for removal");
    expect(never).toContain("| never |");
    expect(never).toMatch(/~\d+ tokens/);
  });

  it("Given the context budget, When it is supplied, Then usage is crossed with cost, per session apart from per invocation", async () => {
    const dir = await repoWithUsage();
    await conclusiveJournal(dir);

    const crossed = await digest(dir, { doctor: true });

    const skill = crossed.skills.find((row) => row.name === "create-skill");
    expect(crossed.limits.cost).toBe("measured");
    // a skill never invoked still costs its metadata at every session, and its
    // body never: adding the two is the impressive, false total to avoid
    expect(skill?.perSession).toBeGreaterThan(0);
    expect(skill?.perInvocation).toBeGreaterThan(0);
    expect(skill?.perSession).toBeLessThan(skill?.perInvocation ?? 0);

    // and each figure is THAT skill's own, not the repository's total: the
    // join is by skill folder, so two skills never carry the same cost
    const items = (await runDoctor(dir)).context?.items ?? [];
    const own = (name: string, when: string): number =>
      items
        .filter(
          (item) =>
            item.path.startsWith(`.agents/skills/${name}/`) &&
            item.when === when,
        )
        .reduce((total, item) => total + item.tokens, 0);
    expect(skill?.perSession).toBe(own("create-skill", "always"));
    expect(skill?.perInvocation).toBe(own("create-skill", "on-invocation"));
    const other = crossed.skills.find((row) => row.name === REVIEW_SKILL);
    expect(other?.perInvocation).not.toBe(skill?.perInvocation);
  });

  it("Given no context budget, When the review runs, Then the cost is reported as not measured rather than as zero", async () => {
    const dir = await repoWithUsage();
    await conclusiveJournal(dir);

    const parsed = await digest(dir);
    const report = await summarize(dir);

    expect(parsed.limits.cost).toBe("not-measured");
    expect(parsed.skills[0]?.perSession).toBeNull();
    expect(report).toContain("not measured");
    expect(report).toContain("An unmeasured cost is not");
    expect(report).not.toContain("~0 tokens");
  });

  it("Given a sub-agent whose frontmatter name differs from its file name, When it is delegated to, Then the journal lines are attributed to it", async () => {
    // the journal records the name a harness uses, which is the frontmatter
    // `name` — matching on the file name would attribute nothing
    const dir = await repoWithUsage();
    await mkdir(join(dir, ".agents", "agents"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "agents", "reviewer-file.md"),
      "---\nname: diff-reviewer\ndescription: Reviews a diff.\n---\n\n# Reviewer\n\nThe delegation body.\n",
      "utf8",
    );
    await writeJournal(dir, {
      days: 14,
      sessionsPerDay: 2,
      agents: ["diff-reviewer"],
    });

    const parsed = await digest(dir, { doctor: true });
    const report = await summarize(dir, { doctor: true });

    const agent = parsed.agents.find((row) => row.name === "diff-reviewer");
    expect(parsed.agents).toHaveLength(1);
    expect(agent?.file).toBe("reviewer-file.md");
    expect(agent?.occurrences).toBe(28);
    expect(agent?.sessions).toBe(28);
    expect(agent?.perSession).toBeGreaterThan(0);
    expect(report).toContain("### Sub-agents");
    expect(report).toContain("diff-reviewer");
    expect(parsed.limits.unnamedDelegations).toBe(0);
  });

  it("Given delegations carrying no agent name, When the review runs, Then it says sub-agent counts are unreliable instead of reporting an absence", async () => {
    // conventions.md §9 records these payload keys as unconfirmed against a
    // live harness; a silent zero would read as "never delegated to"
    const dir = await repoWithUsage();
    await writeJournal(dir, {
      days: 14,
      sessionsPerDay: 2,
      agents: [null],
    });

    const parsed = await digest(dir);
    const report = await summarize(dir);

    expect(parsed.limits.delegations).toBe(28);
    expect(parsed.limits.unnamedDelegations).toBe(28);
    expect(report).toContain("carry no agent name");
    expect(report).toContain("sub-agent counts are unreliable");
  });

  it("Given a truncated last line in a journal file, When the review runs, Then that line is skipped and the rest is still counted", async () => {
    const dir = await repoWithUsage();
    await conclusiveJournal(dir);
    const file = join(
      dir,
      ...USAGE_JOURNAL_DIR.split("/"),
      "usage-2026-08-03.jsonl",
    );
    await writeFile(
      file,
      `${await readFile(file, "utf8")}{"ts":"2026-`,
      "utf8",
    );

    const parsed = await digest(dir);

    expect(parsed.volume.days).toBe(14);
    expect(parsed.volume.sessions).toBe(28);
  });

  it("Given no journal at all, When the review runs, Then it reports an empty window rather than failing", async () => {
    const dir = await repoWithUsage();

    const parsed = await digest(dir);
    const report = await summarize(dir);

    expect(parsed.volume).toMatchObject({ sessions: 0, days: 0, lines: 0 });
    expect(parsed.volume.conclusive).toBe(false);
    expect(report).toContain("empty journal");
    expect(report).toContain("Not concluded");
  });

  it("Given a repo with a journal, When the review runs, Then it writes nothing", async () => {
    const dir = await repoWithUsage();
    await conclusiveJournal(dir);
    const before = await snapshot(dir);

    await summarize(dir);

    expect(await snapshot(dir)).toEqual(before);
  });

  it("Given the review skill installed, When pack remove usage runs, Then it goes with the rest of the pack", async () => {
    const dir = await repoWithUsage();
    await conclusiveJournal(dir);

    await runPackRemove(dir, "usage", { dryRun: false, force: true });

    expect(await pathExists(join(dir, ".agents", "skills", REVIEW_SKILL))).toBe(
      false,
    );
    expect(await pathExists(join(dir, ...USAGE_JOURNAL_DIR.split("/")))).toBe(
      false,
    );
    const check = await runCheck(dir);
    expect(
      check.violations.filter((violation) => violation.severity === "error"),
    ).toEqual([]);
  });
});
