# Interview bank — whole-repo proposal

Ask only what the repo cannot answer — the inventory (step 1) answers the
rest. The five discriminating questions:

1. What did the agents get wrong on this repo recently? (An observed
   failure is the strongest candidate there is; no observed failure, no
   rule.)
2. What is already enforced mechanically — linter, formatter, type
   checker, CI, existing hooks, harness deny rules? (Everything named
   here is EXCLUDED from the proposal.)
3. Which command must an agent never run here — deploy, migration, watch,
   publish? (A candidate blocking hook: the kind of guarantee a repo
   cannot obtain any other way.)
4. Which step of the workflow do you repeat by hand on every change?
   (Candidate hook when it must happen every time, candidate sub-agent
   when it is bulky and isolable.)
5. Which paths are off limits, generated or vendored? (Feeds the scoped
   `paths:` of a rule and the matchers of a hook.)

Present each candidate with its evidence and ask for its verdict —
accept, refuse or amend. A refusal with its reason is worth as much as an
acceptance: it is what stops the same proposal from coming back.
