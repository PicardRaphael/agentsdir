# Agent memory

Read before reading or writing `.agents/memory/`.

## Rules

- `.agents/memory/` is local state, excluded from git: it may hold personal or
  machine-specific data and must never be committed.
- `.agents/memory.template/` is the versioned model: copy it into
  `.agents/memory/` when starting on a fresh clone.
- One file per fact, indexed from `MEMORY.md` — update or delete a memory that
  turns out to be wrong instead of stacking corrections.
