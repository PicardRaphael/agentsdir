# 02 — Détection d'environnement

Dépend de : 01

## Problème

Toutes les commandes ont besoin de connaître l'environnement : les symlinks sont-ils possibles, quelle est la stack du repo, quels harness sont présents.

## Fichiers

- `src/core/detect.ts` + tests

## Critères d'acceptation

- `detectSymlinkSupport(dir)` : crée réellement un symlink temporaire dans `dir`, vérifie son type (`lstat`), le supprime ; retourne `{ supported, reason }`. Ne se fie JAMAIS à la seule plateforme — le test est empirique.
- `detectGitSymlinks(dir)` : lit `git config core.symlinks` et signale les symlinks déjà matérialisés en fichiers texte (contenu = chemin cible, mode index 120000 mais fichier ordinaire sur disque).
- `detectStack(dir)` : reconnaît `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json` ; retourne la ou les stacks et des suggestions de commandes (dev/test/lint) SANS jamais les imposer.
- `detectHarnesses(dir)` : présence de `.claude/`, `.codex/`, `.cursor/`, `CLAUDE.md`, `AGENTS.md` existants — matière première de `doctor` et, plus tard, de `migrate`.
- Tout est pur et testé unitairement (répertoires temporaires), y compris le cas « symlink impossible ».

## Notes d'implémentation

Cas vécu à couvrir : sur la machine de développement du projet (Windows 11 sans mode développeur), `ln -s` produit une copie — `detectSymlinkSupport` doit retourner `supported: false` avec une raison claire.

## Vérification

```bash
npm test -- detect
```

## Hors périmètre

L'écriture du manifeste (03) ; toute décision d'installation (04).
