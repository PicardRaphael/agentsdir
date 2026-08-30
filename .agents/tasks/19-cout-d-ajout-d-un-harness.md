# 19 — Réduire le coût d'ajout d'un harness

## Problème

Ajouter un quatrième harness est aujourd'hui la modification la plus chère de la
CLI. La liste elle-même est centralisée (`core/harnesses.ts`), mais le
comportement par harness reste dispersé en connaissances codées en dur :

- `core/projections.ts` — `CLAUDE_PROJECTIONS` et `CLAUDE_MD_COPY` : le moteur
  ne connaît que Claude Code. Les projections d'un autre harness n'ont nulle
  part où se déclarer.
- `core/hook-registries.ts` — `HOOK_REGISTRY_PATHS`, plus des branches
  `harness === "claude" | "codex" | "cursor"` dans `supports` et `mergeRegistry`
  (forme de fichier propre à Cursor, clé `version`).
- `core/hook-registries.ts` — `HookEventSpec` a un champ par harness
  (`claude: boolean`, `codex: boolean`, `cursor: string | undefined`) : les
  douze événements devraient tous être touchés pour en ajouter un quatrième.
- `core/detect.ts` — `detectHarnesses` teste `.claude`, `.codex`, `.cursor`,
  `CLAUDE.md` un par un.
- `commands/doctor.ts` — `harnessesFinding` pousse les trois noms à la main.
- `commands/init.ts`, `commands/sync.ts`, `commands/add-common.ts`,
  `core/validate.ts` — `includes("claude")` garde les projections.

Neuf endroits, dont plusieurs demandent de comprendre le format d'un fichier
tiers. Ce n'est pas un défaut en soi — trois harness est une décision actée
(`docs/SPEC.md`) et la spéculation coûte plus qu'elle ne rapporte — mais le coût
doit être connu et réduit là où c'est gratuit.

## Fichiers

- `src/core/harnesses.ts` — la liste et les répertoires, déjà centralisés.
- `src/core/hook-registries.ts` — `HookEventSpec`, `HOOK_REGISTRY_PATHS`, `supports`, `mergeRegistry`.
- `src/core/projections.ts` — `CLAUDE_PROJECTIONS`, `CLAUDE_MD_COPY`.
- `src/core/detect.ts` — `detectHarnesses`.
- `src/commands/doctor.ts` — `harnessesFinding`, `detectHarnessesOnPath`.
- `src/commands/init.ts`, `src/commands/sync.ts`, `src/commands/add-common.ts`, `src/core/validate.ts` — les gardes `includes("claude")`.
- `docs/harness.md` — la matrice d'intégration.

## Notes d'implémentation

Procéder par petits pas vérifiables, chacun neutre pour le comportement : la
table des événements d'abord, les sondes de détection ensuite, les gardes en
dernier. Ne pas introduire d'abstraction spéculative pour un harness qui
n'existe pas ; le but est de supprimer la redondance constatée, pas d'ouvrir un
système de plugins.

## Critères d'acceptation

- `HookEventSpec` cesse d'avoir un champ par harness : le support d'un événement
  se déclare par une table `Record<Harness, …>` ou équivalent, de sorte
  qu'ajouter un harness n'oblige pas à éditer les douze événements.
- `detectHarnesses` et `doctor` dérivent leurs sondes de `HARNESS_DIRS`
  (`core/harnesses.ts`) au lieu d'énumérer les répertoires.
- Les gardes `includes("claude")` sont remplacées par une notion explicite
  « ce harness a-t-il des projections de fichiers ? », portée par la déclaration
  du harness et non par son nom.
- Aucun quatrième harness n'est ajouté : la décision reste celle de l'utilisateur.
- Le comportement observable est identique pour les trois harness existants —
  mêmes fichiers écrits, mêmes octets.
- `docs/harness.md` documente ce qu'il faut déclarer pour en ajouter un.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js sync   # attendu : 0 created, 0 updated
node dist/cli.js check
```

Puis, sur un repo de démonstration jetable : `init --yes --harness claude`,
`--harness codex`, `--harness claude,codex,cursor` produisent chacun exactement
les mêmes fichiers qu'avant le refactor.

## Hors périmètre

Ajouter un harness (opencode, Zed, autre) : c'est une décision produit, pas une
tâche de structure. `CLAUDE_PROJECTIONS` peut rester la seule table de
projections tant qu'aucun autre harness n'en réclame.
