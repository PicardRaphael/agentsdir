# 13 — Commande `doctor`

Dépend de : 02

## Problème

Quand quelque chose ne va pas (symlinks matérialisés, mode inadapté, harness manquant), l'utilisateur doit avoir un diagnostic lisible et des remèdes concrets.

## Fichiers

- `src/commands/doctor.ts` + tests

## Critères d'acceptation

- Rapporte, avec un état par ligne : support réel des symlinks (test empirique), `git config core.symlinks`, mode développeur Windows (détection best effort), mode actuel du manifeste et son adéquation à l'environnement, harness détectés vs harness activés, version du schéma du manifeste, présence du workflow de CI.
- Détecte le cas pathologique documenté : symlinks indexés en mode 120000 mais matérialisés en fichiers texte sur le disque (checkout sans `core.symlinks`), avec le remède exact.
- Propose (sans l'appliquer) la bascule de mode quand l'environnement a changé : « symlinks désormais disponibles — lance `agentsdir sync --mode symlink` ».
- Lecture seule stricte ; exit 0 même quand des problèmes sont détectés (c'est un diagnostic, pas une vérification — `check` porte l'échec CI).

## Vérification

```bash
npm test -- doctor
```

## Hors périmètre

La bascule de mode elle-même (option de `sync`).
