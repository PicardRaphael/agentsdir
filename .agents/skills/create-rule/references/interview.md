# Interview bank — rule

Ask only what the code cannot answer. The five discriminating questions:

1. Which observed failure justifies this rule? (No observed failure, no
   rule.)
2. Is it scoped to specific files? (Feeds the `paths:` frontmatter.)
3. Could it be verified mechanically? (Then it belongs to a linter, the
   CI or a hook — not to a rule.)
4. When must an agent read it? (Feeds the when-to-read line under the
   H1, and through it the rules index.)
5. Give the real GOOD and BAD example from the failure — not an invented
   one.

Follow up until the failure is concrete: which file, which commit, what
broke, what should have happened instead.
