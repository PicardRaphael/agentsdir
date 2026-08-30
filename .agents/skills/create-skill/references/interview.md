# Interview bank — skill

Ask only what the code cannot answer. The five discriminating questions,
each derived from a sourced anti-pattern:

1. Give at least 3 phrases that MUST trigger this skill, and at least 2
   near-miss phrases that must NOT. (Feeds the description and the
   trigger test.)
2. Is the output objective (one verifiable right answer) or subjective
   (judgment)? (Objective outputs deserve scripts and checks; subjective
   ones deserve criteria.)
3. Which fragile sequence should be frozen into an executable script
   rather than described in prose?
4. What did you repeat to the agent the last 3 times you did this by
   hand? (That repetition IS the skill body.)
5. Which knowledge is bulky but rarely needed? (It goes to a references
   folder, loaded on demand — one level of indirection only.)

Follow up when an answer stays vague: ask for the exact command, the
exact file, the exact failure — never accept a generality the code
could contradict.
