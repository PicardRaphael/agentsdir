# AGENTS.md

Ce fichier est le point d'entrée des agents IA qui travaillent sur ce repo. Il sera à terme géré par `agentsdir` lui-même (autophagie : ce repo est le premier client de la CLI qu'il documente).

`CLAUDE.md` est un fichier pont qui importe ce fichier (`@AGENTS.md`). Il n'est pas un symlink : sur cette machine, la création de symlinks n'est pas disponible sans le mode développeur Windows — c'est précisément le cas que le mode copie (repli) de la CLI devra couvrir. Ne remplace jamais le pont par une copie du contenu.

## Le projet : agentsdir

CLI open source (MIT) qui installe dans un repo existant une architecture de configuration d'agents fondée sur les standards ouverts (AGENTS.md, Agent Skills) : source de vérité `.agents/`, projections par harness (Claude Code, Codex, Cursor), vérification de dérive en CI. Voir [README.md](README.md) et [docs/SPEC.md](docs/SPEC.md).

**Phase actuelle : implémentation de la v1.** Le squelette du paquet est livré (`src/`, tests Vitest, CI GitHub Actions ubuntu + windows) ; le backlog vit dans `.agents/tasks/`, l'ordre d'exécution dans `.agents/plan/v1.md`.

## Index des règles

Lis la règle correspondante avant de toucher aux fichiers qu'elle couvre :

- `.agents/rules/documentation.md` — tout fichier `*.md` : langue, terminologie canonique, Mermaid, liens, interdits de duplication.
- `.agents/rules/code-conventions.md` — tout fichier `src/**`, `e2e/**` ou config d'outillage : TypeScript strict, dépendances limitées, codes de sortie, déterminisme.
- `.agents/rules/taches.md` — toute prise de tâche dans `.agents/tasks/` : ordre, critères exacts, vérification exécutée, suppression à la livraison.

## Règles de travail

- **Décisions actées** (ne pas rouvrir sans demande explicite de l'utilisateur) : nom `agentsdir`, licence MIT, distribution `npx`, harness v1 = Claude Code + Codex + Cursor, pack worktrees inclus en v1, symlinks avec détection et repli en copies synchronisées, catalogue des skills dans le frontmatter (jamais de catalogue codé en dur). Le tableau complet est dans `docs/SPEC.md`.
- **Périmètre** : suivre l'ordre du plan `.agents/plan/v1.md` ; aucune commande réelle avant la tâche `04-commande-init.md` ; pas de feature hors backlog sans demande explicite de l'utilisateur.

## Definition of Done

Une tâche de `.agents/tasks/` est livrée quand : ses critères d'acceptation sont tous satisfaits ; sa section Vérification a été exécutée et sa sortie collée à l'appui ; typecheck, lint et tests passent (dès que le code existe) ; les documents impactés (`docs/`, ce fichier) sont à jour dans le même commit ; le fichier de la tâche est supprimé. Les noms des tests reprennent les critères d'acceptation au format Given/When/Then.

## Carte du repo

- `README.md` — vision publique et carte de la documentation.
- `TESTING.md` — stratégie de test : tiers retenus, nommage, commandes, non-testé.
- `src/` — code TypeScript de la CLI (`cli.ts`, `exit-codes.ts`, `commands/`, `core/`).
- `docs/SPEC.md` — positionnement, principes, décisions.
- `docs/architecture.md` — architecture technique de la CLI (document de référence).
- `docs/commandes.md` — spécification des commandes.
- `docs/creation-assistee.md` — création assistée : protocole, rubriques de qualité, banques d'interview.
- `docs/conventions.md` — contrats installés et validés dans les repos cibles.
- `docs/harness.md` — matrice d'intégration par harness.
- `docs/roadmap.md` — jalons et critères d'acceptation.
- `docs/recherche/` — analyse du modèle source (NowStack) et paysage concurrentiel.
- `.agents/rules/` — règles de travail détaillées (voir l'index ci-dessus).
- `.agents/plan/v1.md` — plan d'exécution de la v1 (ordre et dépendances des tâches).
- `.agents/tasks/` — backlog v1.
