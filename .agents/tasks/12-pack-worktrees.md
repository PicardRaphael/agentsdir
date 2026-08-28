# 12 — Pack `worktrees`

Dépend de : 08

## Problème

Le pack le plus lourd de la v1 : des scripts de cycle de vie de worktree partagés entre harness, réécrits en Node portable (le modèle source est uniquement Unix : bash, perl, lsof, trash).

## Fichiers

- `src/packs/worktrees/` : `scripts/worktree-setup.mjs`, `worktree-cleanup.mjs`, `worktree-context.mjs` (bibliothèque commune)
- Branchements générés : `.cursor/worktrees.json` (`setup-worktree-unix` / `setup-worktree-windows` selon la plateforme, chemins relatifs à `.cursor/`)

## Critères d'acceptation

- `worktree-context.mjs` : résolution des chemins/noms/ports par la chaîne de variables des harness (`CODEX_WORKTREE_PATH` → `CONDUCTOR_WORKSPACE_PATH` → `CURSOR_WORKTREE_PATH` → cwd, etc.), sans AUCUN chemin machine codé en dur — tout repli vient du manifeste ou du nom du projet.
- Garde-fous conservés du modèle source : refus de s'exécuter dans la copie de travail principale (surmontable par variable d'environnement explicite), fichiers d'environnement transitoires toujours supprimés (`finally`), jamais de suppression récursive brutale sans confirmation.
- Setup/cleanup fonctionnent sous Windows natif (PowerShell absent du chemin critique : tout est Node) et sous Unix — testés en CI sur les deux (la CI du repo tourne déjà sur ubuntu + windows, tâche 01).
- Les hooks spécifiques à une stack (installation des dépendances, clonage d'environnement) sont des points d'extension documentés (commandes déclarées dans le manifeste), pas du code en dur : le pack reste agnostique du langage.
- `.codex/environments/environment.toml` n'est PAS généré (non corroboré par la documentation publique Codex — voir `docs/harness.md`) ; la doc du pack explique comment brancher les scripts dans l'interface Codex.

## Vérification

```bash
npm test -- pack-worktrees
```

## Hors périmètre

`conductor.json` (v1.x) ; le clonage d'environnements spécifiques à un fournisseur (Convex, etc. — packs de stack futurs).
