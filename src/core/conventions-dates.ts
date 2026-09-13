/**
 * The outside norms this CLI applies, as dated data.
 *
 * Practices move faster than repositories, and the only honest way to apply one
 * is to say where it comes from and when it was read. So a norm is data here,
 * never a number written into a condition: `context-budget.ts` and
 * `validate.ts` derive their bounds from this table, `doctor` reports its age,
 * and the `review-form` meta-skill quotes source and date in every proposal it
 * argues.
 *
 * Two absences are deliberate.
 *
 * **No version number.** The Agent Skills specification publishes neither a
 * version nor a changelog, so a norm cannot be dated by its source. Each is
 * dated at the day it was READ, with what was read — the convention
 * `core/hook-registries.ts` already applies to the hook registry formats.
 *
 * **No network.** Nothing here is fetched, refreshed or compared against a
 * registry: the norms ship inside the version of the CLI and travel by npm,
 * like those of any other development tool. `doctor` opens no connection, and
 * a test proves it. Active watch on outside sources was weighed and rejected on
 * 2026-08-30, after a verification found the claim that motivated it half wrong
 * once traced back to the vendor's own pages.
 *
 * What is NOT here: the thresholds agentsdir chose for its own catalog — a body
 * of at least 12 significant lines, a `short-description` of 25 to 64
 * characters, `#RRGGBB` colors, the name grammar. Those are this project's
 * decisions; they have no outside source, and dating them would lend them an
 * authority they have not got.
 */

/** Where a norm was read, in the form the meta-skill has to be able to cite. */
export interface NormSource {
  /** Must identify the document on its own, without the URL. */
  title: string;
  /** Absent when none was recorded at verification time. */
  url?: string;
  /** ISO date the document itself carries, when it carries one. */
  published?: string;
  /** ISO date the document was read — the date a norm ages by. */
  consulted: string;
}

/** Where a norm is applied, and therefore what exceeding it does. */
export type NormApplication =
  /** An invariant of `check`: exit 1, CI red. */
  | "check"
  /** A line of the `doctor` report: information, never a failure. */
  | "doctor"
  /** No code applies it; the `review-form` meta-skill argues from it. */
  | "judgement";

export interface NormBound {
  value: number;
  /** What the number counts, printed beside it. */
  unit: string;
}

interface NormDefinition {
  /** The norm in one sentence, as the source states it. */
  statement: string;
  /** `null` for the norms that are a form, not a number. */
  bound: NormBound | null;
  applied: NormApplication;
  source: NormSource;
}

export interface ConventionNorm extends NormDefinition {
  id: string;
}

const AGENT_SKILLS_SPEC: NormSource = {
  title: "Agent Skills specification (agentskills.io)",
  url: "https://agentskills.io/specification",
  consulted: "2026-08-30",
};

/**
 * Read at the source on 2026-08-30, in the verification that settled the scope
 * of this table. The URL was not recorded that day and is not guessed here: a
 * fabricated link is worse than a citation without one, and the meta-skill is
 * told to re-read the document before quoting it.
 */
const CONTEXT_ENGINEERING_POST: NormSource = {
  title:
    "Anthropic — context engineering for the Claude 5 generation of models",
  published: "2026-07-24",
  consulted: "2026-08-30",
};

/**
 * The table itself, keyed by id so every derivation is a compile-time checked
 * access rather than a lookup that can miss. A norm with no `bound` is a form,
 * not a size: no condition can apply it, which is exactly why it is a skill's
 * business and not the CLI's.
 */
export const NORMS = {
  "skill-name-length": {
    statement: "A skill `name` is at most 64 characters.",
    bound: { value: 64, unit: "characters" },
    applied: "check",
    source: AGENT_SKILLS_SPEC,
  },
  "skill-description-length": {
    statement:
      "A skill `description` is at most 1,024 characters, and every session pays it for every skill.",
    bound: { value: 1024, unit: "characters" },
    applied: "doctor",
    source: AGENT_SKILLS_SPEC,
  },
  "skill-compatibility-length": {
    statement: "A skill `compatibility` field is at most 500 characters.",
    bound: { value: 500, unit: "characters" },
    applied: "judgement",
    source: AGENT_SKILLS_SPEC,
  },
  "skill-body-tokens": {
    statement:
      "A SKILL.md body stays under 5,000 tokens; the depth moves into references/, which is paid only when read.",
    bound: { value: 5000, unit: "tokens" },
    applied: "doctor",
    source: AGENT_SKILLS_SPEC,
  },
  "skill-body-lines": {
    statement: "A SKILL.md body stays under 500 lines.",
    bound: { value: 500, unit: "significant lines" },
    applied: "check",
    source: AGENT_SKILLS_SPEC,
  },
  "skill-startup-metadata": {
    statement:
      "The name and description of EVERY skill are loaded at startup, of the order of a hundred tokens each — the cost that compounds with the size of the catalog.",
    bound: null,
    applied: "doctor",
    source: AGENT_SKILLS_SPEC,
  },
  "progressive-disclosure": {
    statement:
      "A long skill is split across several files instead of written as one block: the body states the procedure, references/ hold the depth.",
    bound: null,
    applied: "judgement",
    source: CONTEXT_ENGINEERING_POST,
  },
  "avoid-over-constraining": {
    statement:
      "System prompts, skills and context files are simplified rather than over-constrained; an over-specified skill does worse than a short one that states its purpose.",
    bound: null,
    applied: "judgement",
    source: CONTEXT_ENGINEERING_POST,
  },
} as const satisfies Record<string, NormDefinition>;

/** Every norm, id included, sorted by id — stable for rendering and for tests. */
export const CONVENTION_NORMS: readonly ConventionNorm[] = Object.entries(NORMS)
  .map(([id, norm]) => ({ id, ...norm }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * The date a set of norms ages by: the OLDEST consultation, never the most
 * recent. A table refreshed in one row and stale in six is as old as its oldest
 * row, and printing the newest date would hide exactly that.
 *
 * It is a function and not a fold written inline because today every source
 * here happens to share one date — so the rule cannot be proved on the shipped
 * table, and a test that tried would pass whichever way the comparison ran. It
 * is proved on norms built for the purpose instead.
 */
export function oldestConsulted(norms: readonly ConventionNorm[]): string {
  // ISO dates sort lexicographically, which is the whole reason the format is
  // the one recorded; an empty set has no date rather than a default one
  const [oldest] = norms.map((norm) => norm.source.consulted).sort();
  return oldest ?? "";
}

/** The date the norms THIS CLI embeds age by. */
export const CONVENTIONS_CONSULTED: string = oldestConsulted(CONVENTION_NORMS);

/**
 * Past this age, `doctor` says so out loud. This is agentsdir's own threshold —
 * it has no outside source and is not dated as a norm: it is the point where
 * "these conventions were current when this CLI shipped" stops being a safe
 * thing to leave unsaid.
 */
export const STALE_AFTER_MONTHS = 6;

/**
 * Whole months elapsed, counted in UTC so the answer does not depend on the
 * machine's zone. A day short of the month does not count it.
 */
export function monthsSince(iso: string, today: Date): number {
  const then = new Date(`${iso}T00:00:00Z`);
  const months =
    (today.getUTCFullYear() - then.getUTCFullYear()) * 12 +
    (today.getUTCMonth() - then.getUTCMonth());
  return today.getUTCDate() < then.getUTCDate() ? months - 1 : months;
}

/** One norm's source, in the form a proposal cites it. */
export function citeSource(source: NormSource): string {
  const published =
    source.published === undefined ? "" : `, published ${source.published}`;
  const url = source.url === undefined ? "" : ` <${source.url}>`;
  return `${source.title}${published}${url}, read ${source.consulted}`;
}

/**
 * The table as the meta-skill reads it, rendered into the pack so the skill
 * quotes the shipped norms instead of recalling norms of its own. Rendered from
 * this module, so a bump here reaches the installed reference at the next
 * `sync` and the drift shows up in `check` if it does not.
 */
export function renderConventionsReference(): string {
  const lines = [
    "# The dated norms",
    "",
    "Every norm below ships with this version of the CLI. **Cite the source and",
    "the date whenever you use one** — a bound quoted bare is an opinion. The",
    "specification publishes no version number, so a norm is dated at the day it",
    "was read, not by its source.",
    "",
    "Nothing here is fetched at run time. If you have network access and the",
    "document has moved on, say so in your report and name the date you read it:",
    "that is a finding about this table, not a licence to replace it.",
    "",
    "| Norm | Bound | Applied by | Source |",
    "| --- | --- | --- | --- |",
  ];
  for (const norm of CONVENTION_NORMS) {
    const bound =
      norm.bound === null
        ? "no bound"
        : `${norm.bound.value} ${norm.bound.unit}`;
    lines.push(
      `| \`${norm.id}\` — ${norm.statement} | ${bound} | ${APPLIED_BY[norm.applied]} | ${citeSource(norm.source)} |`,
    );
  }
  lines.push(
    "",
    "**Applied by** says who already handles the norm, and it decides what you",
    "may propose:",
    "",
    "- `check` — already an invariant. A breach is drift, it is reported, and",
    "  the repository is red. Never propose what `check` has already said.",
    "- `doctor --json` — already measured and printed as information. Take the",
    "  figure from there; never recount it, never round it.",
    "- this skill — nobody applies it. This is where your judgement is the whole",
    "  value, and where every proposal must carry its argument.",
    "",
  );
  return lines.join("\n");
}

const APPLIED_BY: Readonly<Record<NormApplication, string>> = {
  check: "`check` (invariant)",
  doctor: "`doctor` (information)",
  judgement: "`$review-form` (judgement)",
};
