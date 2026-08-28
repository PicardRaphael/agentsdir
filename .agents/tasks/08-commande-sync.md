# 08 — Commande `sync`

Dépend de : 05

## Problème

Le pendant réparateur de `check` : régénérer toutes les projections depuis la source de vérité.

## Fichiers

- `src/commands/sync.ts` + tests

## Critères d'acceptation

- Régénère : projections Claude Code (symlinks ou copies selon le manifeste), `agents/openai.yaml` + icônes de chaque skill, index des règles d'`AGENTS.md` (bloc géré), empreintes du manifeste et de `skills-lock.json`.
- N'écrit que ce qui diffère (comparaison octet à octet) et rapporte created/updated/ok par fichier.
- `--dry-run` affiche le plan d'écriture complet.
- Ne touche JAMAIS aux sources (`.agents/**`, sections non gérées d'`AGENTS.md`) : si une source est invalide, `sync` échoue avec le diagnostic de `validate`, il ne « corrige » pas silencieusement.
- Séquence `sync` puis `check` → toujours exit 0 (propriété testée).

## Vérification

```bash
npm test -- sync
```

## Hors périmètre

La création de contenu (générateurs, tâche 09).
