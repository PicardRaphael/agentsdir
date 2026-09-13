import { describe, expect, it } from "vitest";
import { MAX_BODY_TOKENS, MAX_DESCRIPTION_CHARS } from "../context-budget.js";
import {
  citeSource,
  CONVENTION_NORMS,
  CONVENTIONS_CONSULTED,
  monthsSince,
  NORMS,
  oldestConsulted,
  renderConventionsReference,
  STALE_AFTER_MONTHS,
} from "../conventions-dates.js";
import { NAME_SPEC } from "../validate.js";

/**
 * Criterion: "the applied norms are versioned data, each carrying its bound,
 * its source and its date of consultation; none is written into a condition of
 * the code."
 */
describe("Given the norms this CLI applies", () => {
  it("When a norm is read, Then it carries a source and the date that source was consulted", () => {
    expect(CONVENTION_NORMS.length).toBeGreaterThan(0);
    for (const norm of CONVENTION_NORMS) {
      expect(norm.statement, norm.id).not.toBe("");
      expect(norm.source.title, norm.id).not.toBe("");
      expect(norm.source.consulted, norm.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (norm.source.published !== undefined) {
        expect(norm.source.published, norm.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("When a norm constrains a size, Then it carries its bound as a number and a unit", () => {
    const bounded = CONVENTION_NORMS.filter((norm) => norm.bound !== null);
    expect(bounded.length).toBeGreaterThan(0);
    for (const norm of bounded) {
      expect(norm.bound?.value, norm.id).toBeGreaterThan(0);
      expect(norm.bound?.unit, norm.id).not.toBe("");
    }
  });

  it("When the code applies a spec bound, Then it reads it from the table instead of holding its own copy", () => {
    expect(MAX_DESCRIPTION_CHARS).toBe(
      NORMS["skill-description-length"].bound.value,
    );
    expect(MAX_BODY_TOKENS).toBe(NORMS["skill-body-tokens"].bound.value);
    // the name grammar is agentsdir's, the LENGTH is the spec's: a name of
    // exactly the bound passes, one character more does not
    const bound = NORMS["skill-name-length"].bound.value;
    expect(NAME_SPEC.test("a".repeat(bound))).toBe(true);
    expect(NAME_SPEC.test("a".repeat(bound + 1))).toBe(false);
  });

  it("When several norms were read on different days, Then the set ages by the oldest, not the most recent", () => {
    // built here on purpose: every source shipped today shares one date, so the
    // rule cannot be told apart from its opposite on the real table
    const norm = (id: string, consulted: string) => ({
      ...NORMS["skill-name-length"],
      id,
      source: { title: "t", consulted },
    });
    expect(
      oldestConsulted([
        norm("fresh", "2026-08-30"),
        norm("stale", "2025-01-15"),
        norm("middling", "2026-02-02"),
      ]),
    ).toBe("2025-01-15");
    expect(oldestConsulted([])).toBe("");
  });

  it("When the shipped table is the set, Then that is the date the CLI reports", () => {
    expect(CONVENTIONS_CONSULTED).toBe(oldestConsulted(CONVENTION_NORMS));
    expect(CONVENTION_NORMS.map((n) => n.source.consulted)).toContain(
      CONVENTIONS_CONSULTED,
    );
  });

  it("When a source is cited, Then the citation names the document and the day it was read", () => {
    const cited = citeSource(NORMS["skill-description-length"].source);
    expect(cited).toContain("agentskills.io");
    expect(cited).toContain(
      `read ${NORMS["skill-description-length"].source.consulted}`,
    );
  });
});

describe("Given an age counted in whole months", () => {
  it("When the day of the month has not come round yet, Then the month does not count", () => {
    expect(monthsSince("2026-01-15", new Date("2026-02-14T00:00:00Z"))).toBe(0);
    expect(monthsSince("2026-01-15", new Date("2026-02-15T00:00:00Z"))).toBe(1);
  });

  it("When a year is crossed, Then the count keeps running", () => {
    expect(monthsSince("2025-11-30", new Date("2026-09-13T00:00:00Z"))).toBe(9);
    expect(monthsSince("2026-09-13", new Date("2026-09-13T00:00:00Z"))).toBe(0);
  });

  it("When the age is compared to the notice threshold, Then six months is not yet past it", () => {
    expect(STALE_AFTER_MONTHS).toBe(6);
    expect(monthsSince("2026-03-13", new Date("2026-09-13T00:00:00Z"))).toBe(6);
    expect(monthsSince("2026-03-12", new Date("2026-09-13T00:00:00Z"))).toBe(6);
    expect(monthsSince("2026-02-13", new Date("2026-09-13T00:00:00Z"))).toBe(7);
  });
});

describe("Given the reference the meta-skill reads", () => {
  it("When it is rendered twice, Then it is identical byte for byte and sorted by norm", () => {
    const once = renderConventionsReference();
    expect(renderConventionsReference()).toBe(once);
    const ids = [...once.matchAll(/^\| `([a-z-]+)`/gm)].map(
      (match) => match[1],
    );
    expect(ids).toEqual(CONVENTION_NORMS.map((norm) => norm.id));
    expect(ids).toEqual([...ids].sort());
  });

  it("When a norm appears in it, Then its bound, its source and its date appear on the same row", () => {
    const rendered = renderConventionsReference();
    for (const norm of CONVENTION_NORMS) {
      const row = rendered
        .split("\n")
        .find((line) => line.startsWith(`| \`${norm.id}\``));
      expect(row, norm.id).toBeDefined();
      expect(row, norm.id).toContain(norm.source.consulted);
      expect(row, norm.id).toContain(norm.source.title);
      if (norm.bound !== null) {
        expect(row, norm.id).toContain(
          `${norm.bound.value} ${norm.bound.unit}`,
        );
      }
    }
  });

  it("When a norm has no bound, Then it is presented as a form and not as a size", () => {
    const formOnly = CONVENTION_NORMS.filter((norm) => norm.bound === null);
    expect(formOnly.length).toBeGreaterThan(0);
    const rendered = renderConventionsReference();
    for (const norm of formOnly) {
      const row = rendered
        .split("\n")
        .find((line) => line.startsWith(`| \`${norm.id}\``));
      expect(row, norm.id).toContain("no bound");
    }
  });
});
