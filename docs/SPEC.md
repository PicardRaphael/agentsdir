# SPEC — vision et périmètre

## Le problème

Chaque harness d'agent de code lit sa propre configuration : Claude Code charge `CLAUDE.md` et `.claude/`, Codex lit `AGENTS.md` et `.agents/skills/`, Cursor a `.cursor/`. Les équipes qui utilisent plusieurs agents dupliquent leurs instructions, et les copies divergent silencieusement. Les standards ont pourtant convergé — `AGENTS.md` (Agentic AI Foundation) est lu par plus de trente agents et `.agents/skills/` est la convention de skills que Codex, Cursor et opencode découvrent nativement — mais aucun outil n'installe cette architecture dans un repo existant, ni ne garantit qu'elle ne dérive pas.

## La proposition

`agentsdir` installe et entretient, dans n'importe quel repo (Python, TypeScript, Go, peu importe), une architecture en deux couches :

1. **Une source de vérité** : `.agents/` (règles, skills, sous-agents, tâches, plans, mémoire) et `AGENTS.md` comme point d'entrée.
2. **Des projections par harness**, régénérables et vérifiables : symlinks (ou copies synchronisées en repli) pour Claude Code, métadonnées `agents/openai.yaml` + icônes SVG pour Codex, enregistrements de hooks pour les trois harness.

L'accroche : **« installe dans n'importe quel repo l'architecture d'agents que Codex, Cursor et opencode lisent déjà nativement — et fait le pont pour Claude Code. »**

## Les six principes de design

1. **Une source, des projections.** Tout vit dans `.agents/` ; `CLAUDE.md`, `.claude/*`, `openai.yaml`, les icônes et l'index des règles d'`AGENTS.md` sont des projections régénérables, jamais éditées à la main.
2. **Rien d'imposé au repo cible.** La CLI s'exécute via `npx` ; les artefacts générés sont du Markdown, du YAML, du JSON et du SVG purs. Aucun `package.json` requis, aucune dépendance d'exécution dans le projet.
3. **Tout ce qui est généré est vérifiable.** `agentsdir check` valide les invariants et détecte la dérive, avec un code de sortie exploitable ; le workflow de CI est émis dès `init`.
4. **Additif et idempotent.** `init` sur un repo déjà rempli ne touche que ses fichiers ; dans un `AGENTS.md` existant, la CLI n'écrit que dans ses blocs gérés (`<!-- agentsdir:begin … -->`).
5. **Le frontmatter est le catalogue.** Les métadonnées d'un skill (nom affiché, couleur, icône, prompt) vivent dans le frontmatter de son `SKILL.md`. Ajouter un skill = créer un dossier, jamais éditer un script.
6. **Détection de stack, pas dépendance à la stack.** `init` détecte le langage du projet uniquement pour pré-remplir les commandes (dev, test, lint) et proposer les packs pertinents.

## Ce que le projet n'est pas (hors périmètre assumé)

- **Pas un synchroniseur vers 40 harness exotiques** : trois harness majeurs bien servis (Claude Code, Codex, Cursor) plutôt qu'une matrice d'adaptateurs fragile. Les autres lecteurs d'`AGENTS.md` fonctionnent déjà sans adaptateur.
- **Pas une marketplace de skills** : `agentsdir` interopère avec les skills installés par `npx skills` (Vercel) et respecte la spécification agentskills.io ; il ne distribue pas de contenu.
- **Pas un format propriétaire** : aucun répertoire intermédiaire à apprendre (contrairement à `.ruler/` ou `.rulesync/`). Ce que la CLI installe est exactement ce que les harness lisent.
- **Pas un générateur de prompts** : la qualité du contenu des règles et skills appartient à l'utilisateur ; la CLI fournit les gabarits, les contrats et la vérification.

## Décisions actées

| Décision | Choix | Date |
| --- | --- | --- |
| Nom | `agentsdir` (libre sur npm, vérifié) | 2026-08-27 |
| Licence | MIT | 2026-08-27 |
| Distribution | `npx` (binaires compilés envisageables plus tard) | 2026-08-27 |
| Harness v1 | Claude Code, Codex, Cursor | 2026-08-27 |
| Périmètre v1 | Noyau générique + packs (verification, changelog, worktrees) | 2026-08-27 |
| Pack worktrees | Inclus en v1, réécrit en Node portable | 2026-08-27 |
| Symlinks | Détection réelle + repli en copies synchronisées | 2026-08-27 |
| Catalogue des skills | Frontmatter étendu de `SKILL.md` | 2026-08-27 |
| Langue de la CLI et des docs publiques | Anglais à la release ; conception en français | 2026-08-27 |
| Création assistée | En v1 : pack `creator` + `$setup-context`, approche hybride (CLI = structure, méta-skills = interview) | 2026-08-28 |
| Analyse du repo | `$setup-context` fait analyser le code par l'agent pour pré-rédiger AGENTS.md | 2026-08-28 |
| `update` | Met à niveau les contenus CLI intacts (suivi par empreinte), préserve et signale les modifiés | 2026-08-28 |

## Origine

L'architecture installée par `agentsdir` est une généralisation du modèle observé et analysé en profondeur dans le repo NowStack (starter SaaS multi-harness), débarrassé de ses défauts constatés — l'analyse complète est dans [recherche/analyse-nowstack.md](recherche/analyse-nowstack.md), l'étude de marché dans [recherche/paysage-open-source.md](recherche/paysage-open-source.md).
