---
name: review-form
description: "Confronts the form of this repo's agent configuration with the dated norms this CLI embeds — description and body bounds, progressive disclosure, over-constrained instructions — and proposes changes, each quoting the norm, its source and the day it was read. Use when the user asks whether the configuration is still well shaped, whether a skill should be split or simplified, or whether its practices have aged."
disable-model-invocation: true
display-name: "Review Form"
short-description: "Reviews whether the configuration form still fits"
color: "#0369A1"
icon: badge-check
default-prompt: "Use $review-form to review whether this repo's agent configuration still has the recommended form."
implicit: false
---

# Review Form

A configuration can be in step with its source, genuinely used and cheap,
and still be badly shaped. Nothing in this product says so — that is what
this skill is for. Produce a Markdown report of **proposals**, each one
quoting the norm it rests on, where that norm comes from, and the day it was
read. Change nothing: the tool proposes, the team decides.

## 0. Stay inside your question

Four questions can be asked of an installed configuration. You answer one.

| Question | Who answers it | How |
| --- | --- | --- |
| Has the configuration **drifted** from its source? | `check` | `agentsdir check` |
| Does it **serve**? | `$review-usage` (pack `usage`) | the usage journal, over enough sessions |
| What does it **cost** in context? | `doctor` | `agentsdir doctor --json`, key `context` |
| Is its **form** still the one recommended? | this skill | the dated norms, read from `references/conventions.md` |

- **Never mix two rows.** A proposal says one thing about form. If you
  notice drift, usage or cost while reading, write it under
  *Not this report's question* with the command that answers it — never as
  a finding of your own.
- A form problem is never a reason to say an element is unused, expensive or
  out of step, and the reverse holds. They are independent, and a report
  that blurs them sends the team looking in the wrong file.

## 1. Read the norms before looking at the repo

- Read `.agents/skills/review-form/references/conventions.md`. It holds every norm this version of the CLI
  applies, each with its bound, its source and the date that source was read.
- **Quote from that file. Never from memory.** A bound you recall is an
  opinion in a confident voice; a bound you quote carries a date the reader
  can argue with.
- Read the repository the norms speak about first, in this order:

  ```bash
  agentsdir doctor --json > .agents/output/form/doctor.json
  ```

- The `context.bounds.exceeded` array of that file already lists the size
  bounds this repository crosses, measured exactly. **Take those figures;
  never recount them, never round one.** Your work starts where the
  measurement stops: why the bound is crossed, and what shape would fix it.

## 2. Inventory the form

For every `.agents/skills/*/SKILL.md`, every `.agents/agents/*.md` and every
`.agents/rules/*.md`, note what the norms can be applied to:

- the length of the `description` and of the body, from the doctor file;
- whether the depth sits in the body or in `references/`, and whether the
  body states a procedure or repeats one;
- whether the instructions constrain the agent's steps or state its purpose
  and leave the steps open;
- whether one file covers one subject, or several that never occur together.

Read the files. An inventory built from filenames judges nothing.

## 3. Write a proposal, not a verdict

Every proposal carries, in this order and with nothing missing:

1. **What to change**, in one sentence, naming the file.
2. **The norm**, quoted from the reference, with its bound when it has one.
3. **Its source and the date it was read**, copied from the reference. A
   proposal without these three is not a proposal: delete it.
4. **The evidence in this repository** — the line, the figure from the
   doctor file, the structure you read. Not an impression.
5. **What it would change and what it would cost**, including when the
   answer is "a little clarity for a morning of work".

Order the proposals by the weight of their evidence, not by how easy they
are to apply.

## 4. Say what you cannot say

- A norm with **no bound** — progressive disclosure, over-constrained
  instructions — is a form, not a size. You are judging, and the report must
  say so in those words. Do not dress an appreciation as a measurement.
- The norms were read on 2026-08-30 and ship inside this CLI.
  If you have network access and the source has moved on, report that as a
  finding **about this table** — naming the document, the change and the day
  you read it — and keep the shipped norm as the one you applied. Updating
  the table is a change to the CLI, not to this report.
- If nothing crosses a norm, say exactly that. A report that manufactures
  three proposals to look useful costs more than it gives.

## 5. Nothing leaves the repository

- Write the report to `.agents/output/form/review-<YYYY-MM-DD>.md`, which
  git ignores.
- Send nothing anywhere: no upload, no issue, no paste into a third-party
  tool, no query to a registry to check a version. The CLI itself opens no
  connection, and a test proves it — do not be the part that does.
- **Apply nothing.** Edit no `SKILL.md`, run no `agentsdir sync`, delete
  nothing. If the team accepts a proposal, they run the change themselves,
  and `check` then has the last word.

## Verification

Before handing the report over, check every line of it:

- every proposal quotes a norm, a source and a date;
- no proposal answers drift, usage or cost;
- every figure comes from the doctor file, unrounded;
- no file of the repository was modified;
- the rubric in `.agents/skills/review-form/references/rubrique.md` passes on every
  section.
