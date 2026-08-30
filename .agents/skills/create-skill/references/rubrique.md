# Skill quality rubric

Criteria marked ▣ are enforced mechanically by `agentsdir check`; the
others belong to the critique pass (step 4).

## ▣ Mechanical — check fails on these

- ▣ `name`: 1-64 characters of a-z, 0-9 and -, equal to the folder name.
- ▣ Body between 12 and 500 significant lines; bulky knowledge moves to a
  references folder (progressive disclosure, ONE level of indirection).
- ▣ Complete extended frontmatter: display-name, short-description of 25
  to 64 characters, color #RRGGBB, icon from the embedded set,
  default-prompt containing the exact `$<name>` token.
- ▣ `disable-model-invocation: true` on any skill that can write;
  `implicit` reserved for read-only skills (invocation parity).
- ▣ Every references, scripts or steps path mentioned in the body exists
  on disk — a dead pointer is a lying skill.
- ▣ Codex artifacts byte-identical to the frontmatter render (run `sync`).

## Critique pass

- Description in third person: what + when + the user's own trigger
  keywords — never "Helps with…".
- Trigger test recorded: at least 3 phrases that must trigger, at least 2
  near-misses that must not.
- Explicit degrees of freedom: a fragile sequence becomes an executable
  script, not prose; several valid approaches become instructions.
- One default plus one escape hatch — never a menu of options.
- Constant terminology; no perishable information (versions, dates, URLs).
- Every line passes the filter question: "if this line is deleted, will the agent make a mistake?"
