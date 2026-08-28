# 11 — Packs `verification` et `changelog`

Dépend de : 08

## Problème

Le premier pack de contenu : un skill `$verify` générique (matrice de preuve, verdict PASS / NOT PROVEN / BLOCKED, rapport HTML autonome) et sa règle, transposés du modèle source sans ses adhérences produit.

## Fichiers

- `src/packs/verification/` : `skills/verify/SKILL.md` (+ `references/`, `scripts/build-report.mjs`), `rules/verification.md`
- `src/packs/changelog/` : `rules/changelog.md`, gabarit `CHANGELOG.md`
- `src/commands/pack.ts` — les commandes `pack add <name>` / `pack remove <name>` elles-mêmes (première implémentation, réutilisée par les packs suivants)
- Branchement dans `init` et dans `pack add verification` / `pack add changelog`

## Critères d'acceptation

- Le skill est harness-agnostique : le script de rapport est du Node sans dépendance, les chemins se résolvent depuis la racine du repo, aucun outil propriétaire requis.
- La matrice de preuve est générique : critères d'acceptation → étapes observées → évidences (sorties de commandes, captures) ; aucun renvoi à des fichiers qui n'existent pas dans le repo cible (leçon de l'analyse NowStack : jamais de référence normative vers du code absent).
- La règle `verification.md` suit le gabarit des règles et entre dans l'index via bloc géré.
- `check` passe sur un repo où le pack vient d'être installé ; `pack remove verification` retire proprement skill, règle et ligne d'index.
- Le pack `changelog` installe la règle `changelog` au gabarit et amorce `CHANGELOG.md` à la racine ; installable/désinstallable comme `verification`.

## Vérification

```bash
npm test -- pack-verification
```

## Hors périmètre

Le pack `worktrees` (tâche 12).
