> Version française archivée du README. La version courante et faisant foi est [le README en anglais](../README.md).

# agentsdir

> Installe dans n'importe quel repo l'architecture d'agents que Codex, Cursor et opencode lisent déjà nativement — et fait le pont pour Claude Code.

`agentsdir` est une CLI open source (MIT) qui met en place, dans un projet existant — quel que soit son langage —, une architecture de configuration d'agents de code fondée sur les standards ouverts :

- **une source de vérité unique** : le répertoire `.agents/` (`rules/`, `skills/`, `agents/`, `tasks/`, `plan/`, `memory/`) et le fichier `AGENTS.md` ;
- **des projections par harness** : `CLAUDE.md` et `.claude/*` pour Claude Code (symlinks, ou copies synchronisées quand les symlinks ne sont pas disponibles), `agents/openai.yaml` + icône SVG par skill pour Codex, enregistrements de hooks pour Claude Code, Codex et Cursor ;
- **zéro dérive** : tout ce qui est généré est vérifiable (`agentsdir check`, branché en CI dès l'installation) et régénérable (`agentsdir sync`).

## Statut

**Phase de conception.** Aucun code n'est encore écrit : ce repo contient le plan, la documentation d'architecture et le backlog de la v1. Le point d'entrée est [`docs/roadmap.md`](roadmap.md).

## Pourquoi

`AGENTS.md` est devenu un standard (Agentic AI Foundation / Linux Foundation) lu par plus de trente agents, et `.agents/skills/` est la convention de skills que Codex, Cursor et opencode découvrent nativement. Mais aucun outil n'installe cette architecture complète dans un repo, ne gère le repli quand les symlinks ne sont pas disponibles (Windows sans mode développeur), ne génère les métadonnées Codex par skill, ni n'enregistre un même hook dans les trois harness. C'est le créneau d'`agentsdir` — l'étude complète est dans [`docs/recherche/paysage-open-source.md`](recherche/paysage-open-source.md).

## Aperçu (cible v1)

```bash
npx agentsdir init          # installe l'architecture, interactif
npx agentsdir add skill ma-procedure
npx agentsdir add rule conventions-api --paths "src/api/**"
npx agentsdir add hook PreToolUse
npx agentsdir sync          # régénère les projections
npx agentsdir check         # vérifie invariants et dérive (CI)
npx agentsdir doctor        # diagnostic de l'environnement
```

## Documentation

| Document | Contenu |
| --- | --- |
| [`docs/SPEC.md`](SPEC.md) | Positionnement, principes de design, décisions actées |
| [`docs/architecture.md`](architecture.md) | Architecture technique de la CLI, manifeste, stratégie symlink/repli |
| [`docs/commandes.md`](commandes.md) | Spécification de chaque commande |
| [`docs/creation-assistee.md`](creation-assistee.md) | Création assistée : méta-skills, rubriques de qualité, interviews |
| [`docs/conventions.md`](conventions.md) | Contrats installés et validés : skills, règles, blocs gérés, verrou |
| [`docs/harness.md`](harness.md) | Matrice d'intégration Claude Code / Codex / Cursor |
| [`docs/roadmap.md`](roadmap.md) | Jalons v0.1 → v1 → v1.x → v2 et critères d'acceptation |
| [`docs/recherche/`](recherche/) | Analyse du modèle source (NowStack) et paysage concurrentiel |
| [`.agents/tasks/`](../.agents/tasks/) | Backlog v1, une tâche auto-suffisante par fichier |

Ce repo applique sa propre architecture dès aujourd'hui : les agents qui y travaillent lisent [`AGENTS.md`](../AGENTS.md).

> Note : la documentation est rédigée en français pendant la phase de conception. Le README, la documentation publique et les messages de la CLI seront publiés en anglais avant la première release (voir la tâche dédiée du backlog).

## Licence

[MIT](../LICENSE) © 2026 Raphael Picard
