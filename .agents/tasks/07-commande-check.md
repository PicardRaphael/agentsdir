# 07 — Commande `check`

Dépend de : 05

## Problème

La promesse « zéro dérive » n'existe que si une commande en lecture seule la vérifie, en local et en CI, avec un code de sortie exploitable.

## Fichiers

- `src/commands/check.ts`, `src/core/validate.ts` + tests

## Critères d'acceptation

- Lecture seule stricte : aucun fichier modifié, quel que soit le résultat.
- Vérifie, dans l'ordre, avec messages nominatifs par violation (fichier + règle + correction proposée) :
  1. santé des projections (`verify` du moteur 05) : symlink remplacé par une copie, copie modifiée à la main, projection manquante, en-tête retiré ;
  2. invariants des skills (liste de `docs/conventions.md`) : identité du nom, parité d'invocation, implicite = lecture seule, bornes de `short_description`, couleur, `$<name>` dans le prompt, corps ≥ 12 lignes, existence des fichiers référencés (`references/`, `scripts/`, `steps/`), synchronisation octet à octet d'`openai.yaml` et de l'icône ;
  3. index des règles d'`AGENTS.md` synchronisé avec `.agents/rules/` (bloc géré) ;
  4. empreintes de `skills-lock.json` (si présent).
- Codes de sortie : 0 propre, 1 au moins une dérive ou un invariant violé, 2 environnement invalide (pas de manifeste, schéma inconnu).
- `--json` pour la consommation machine.
- C'est la commande exécutée par le workflow `agents-check.yml` émis par `init` — vérifier que le gabarit du workflow l'appelle bien.

## Vérification

```bash
npm test -- check
```

## Hors périmètre

La réparation (c'est `sync`, tâche 08).
