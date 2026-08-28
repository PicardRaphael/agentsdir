# 10 — `add hook` multi-harness

Dépend de : 09

## Problème

Claude Code, Codex et Cursor ont convergé sur les mêmes noms d'événements de hooks, mais chacun a son fichier d'enregistrement. Écrire le script une fois et l'enregistrer trois fois n'existe nulle part : c'est le différenciateur le plus visible de la CLI.

## Fichiers

- `src/commands/add-hook.ts`, `src/core/hook-registries.ts` + tests
- Gabarit de script dans `src/templates/hook.mjs`

## Critères d'acceptation

- `add hook <event>` avec `<event>` parmi les événements communs (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart au minimum) : crée `.agents/hooks/<event>-<slug>.mjs` (Node portable, sans dépendance, lisant l'entrée JSON sur stdin comme l'attendent les trois harness) et l'enregistre dans chaque harness actif du manifeste :
  - `.claude/settings.json` : structure `hooks` avec matcher, fusion non destructive avec le contenu existant ;
  - `.codex/hooks.json` : événements à la racine, fusion non destructive ;
  - `.cursor/hooks.json` : `version: 1` et forme propre à Cursor, fusion non destructive.
- La matrice exacte des trois formats vit dans `src/core/hook-registries.ts` avec un commentaire de source (voir `docs/harness.md`) et une date de dernière validation — c'est la partie la plus susceptible de casser entre versions des harness.
- Désinscription propre : `add hook` sait retirer un enregistrement orphelin (script supprimé) via `sync`.
- Un test d'intégration vérifie la fusion dans des fichiers d'enregistrement préexistants non triviaux (hooks déjà déclarés par l'utilisateur).

## Notes d'implémentation

Revalider les trois formats contre les docs officielles au moment de l'implémentation (précédent connu : le format Cursor a déjà changé entre versions). Si un format a bougé, mettre à jour `docs/harness.md` dans le même commit.

## Vérification

```bash
npm test -- hook
```

## Hors périmètre

Une bibliothèque de hooks prêts à l'emploi (post-v1, éventuel pack).
