# Paysage open source : standards, concurrents, positionnement

État des lieux vérifié le **27 août 2026**. Les étoiles GitHub ont été relevées ce jour-là via l'API GitHub ; les chiffres d'adoption (« 60 000 repos », « 32 outils ») proviennent d'articles secondaires de 2026, plausibles mais non recomptés. La disponibilité des noms npm a été vérifiée le même jour sur le registre.

Voir aussi : [../roadmap.md](../roadmap.md) (ce que ce paysage implique pour le calendrier), [../harness.md](../harness.md) (la matrice technique par harness).

## 1. Les standards : le vent porte

### AGENTS.md

Lancé par OpenAI en août 2025 (fil Hacker News à 837 points), transféré fin 2025 à l'Agentic AI Foundation (Linux Foundation) pour une gouvernance neutre. Adopté par plus de 60 000 repos open source et lu nativement par plus de 30 agents : OpenAI Codex, GitHub Copilot, Cursor, Gemini CLI, Google Jules, Aider, Zed, Windsurf, Devin, Factory, Amp, RooCode, Warp, JetBrains Junie, opencode…

**L'exception majeure est Claude Code**, qui en août 2026 ne lit toujours que `CLAUDE.md`. La demande de support natif (issue `anthropics/claude-code#34235`, mars 2026) est marquée en doublon de plusieurs issues identiques, sans réponse officielle. Le contournement documenté partout : `CLAUDE.md` réduit à un import `@AGENTS.md` ou un symlink — exactement le pont qu'agentsdir installe.

### Agent Skills (SKILL.md)

Spécification publiée en standard ouvert par Anthropic le 18 décembre 2025 (agentskills.io). Adoptée en 48 heures par Microsoft (VS Code) et OpenAI (ChatGPT + Codex CLI) ; en mars 2026, plus de 32 outils la lisent (Gemini CLI, JetBrains Junie, Kiro d'AWS, Goose de Block…).

### `.agents/skills/` : la convention cross-client

Point décisif pour ce projet : `.agents/skills/` est devenu la convention neutre lue nativement par plusieurs harness — Codex scanne `.agents/skills` du répertoire courant jusqu'à la racine du repo ; Cursor ramasse `.cursor/skills/` **ou** `.agents/skills/` n'importe où dans le repo ; opencode lit dans l'ordre `.opencode/skills`, `.claude/skills`, `.agents/skills`. L'architecture qu'agentsdir installe n'est donc pas une invention locale : elle surfe sur les standards au lieu d'imposer un format propriétaire.

### `agents/openai.yaml` : les métadonnées Codex par skill

Confirmé comme format officiel : dans le dossier d'un skill, `agents/openai.yaml` porte les métadonnées d'interface ChatGPT/Codex (`display_name`, `short_description`, `brand_color`, `icon_small` → SVG, `icon_large`, politique d'invocation). **Aucun outil recensé ne génère ces fichiers automatiquement.**

### Hooks : mêmes événements, trois formats d'enregistrement

Claude Code expose 31 événements de hooks. Codex CLI a désormais des hooks dans `.codex/hooks.json` avec **les mêmes noms d'événements** (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart…) mais un format d'enregistrement différent. Cursor utilise `.cursor/hooks.json` (`"version": 1`), même jeu d'événements plus `beforeShellExecution`/`beforeMCPExecution`, mais la forme `{"matcher", "hooks"}` de Claude n'y fonctionne pas. Conclusion unanime des guides : un script de hook est portable, son fichier d'enregistrement ne l'est pas — un problème de générateur, pas de standard.

### Point non corroboré

Le chemin `.codex/environments/environment.toml` observé dans le repo NowStack n'apparaît dans aucune documentation publique Codex (les environnements cloud se configurent dans l'interface web ; la surface repo documentée est `.codex/config.toml`). À revérifier avant d'en faire une fonctionnalité.

## 2. Les concurrents

| Outil | Étoiles | Ce qu'il fait | Ce qu'il ne couvre pas |
| --- | --- | --- | --- |
| [vercel-labs/skills](https://github.com/vercel-labs/skills) (`npx skills`) | 29 770 | Gestionnaire de paquets de skills : 77+ agents, symlinks vers une copie canonique, `add/find/update/init`, catalogue public skills.sh | Skills uniquement — ni règles, ni AGENTS.md, ni hooks, ni installation d'architecture, ni openai.yaml |
| [davila7/claude-code-templates](https://github.com/davila7/claude-code-templates) | 30 422 | Installeur de composants Claude Code (600+ agents, 200+ commandes, 55+ MCP, 39+ hooks) | Claude Code uniquement : pas de source de vérité multi-harness |
| [intellectronica/ruler](https://github.com/intellectronica/ruler) | 2 895 | Source de vérité `.ruler/` (règles concaténées + `ruler.toml`), distribution par copies vers 30+ agents, skills et sous-agents expérimentaux, config MCP | Copies uniquement (dérive entre deux exécutions), pas de symlinks, pas de générateurs, pas de migration, pas de tasks/plan/memory |
| [dyoshikawa/rulesync](https://github.com/dyoshikawa/rulesync) | 1 354 | Source de vérité `.rulesync/` ; génère règles, commandes, sous-agents, skills, MCP, hooks et permissions pour 40+ outils ; `import` depuis Cursor/CLAUDE.md/Copilot | Format intermédiaire propriétaire, copies, pas d'openai.yaml, pas d'architecture de repo, pas de worktrees |
| [anthropics/skills](https://github.com/anthropics/skills) | 171 993 | Catalogue officiel d'exemples de skills | Un catalogue, pas un outil d'installation ni de synchronisation |
| [openai/skills](https://github.com/openai/skills) | 25 221 | Catalogue officiel de skills Codex (avec la convention `agents/openai.yaml`) | Idem |
| Micro-clones : PanisHandsome/ai-rules-sync (118), lbb00/ai-rules-sync (36), yelmuratoff/agent_sync (14)… | < 150 chacun | Conversion AGENTS.md ⟷ CLAUDE.md ⟷ .cursorrules | Règles uniquement — leur multiplication est en soi le signal d'une demande récurrente non satisfaite |
| Morts : mitkury/airul (34), luisrudge/dot-ai (17), block/ai-rules (128, inactif depuis mai 2026) | — | Générateurs de configs abandonnés | — |

Voisinage npm (paquets actifs occupant les noms proches, relevé du 27/08/2026) : `dotagents` (0.4.0, publié en août 2026 — bibliothèque portable de skills entre machines), `dotagent` (2.10.0 — gestionnaire de configuration `.agent/`), `agents-init` (1.0.2, janvier 2026 — initialisation de docs d'agents et skills). Trois outils récents et actifs sur des noms adjacents : la niche bouge.

## 3. Les six manques que personne ne comble

1. **L'installation d'une architecture complète** — `.agents/{rules,skills,agents,tasks,plan,memory}` + point d'entrée : les outils existants synchronisent du contenu, aucun n'installe une architecture. La « mémoire de projet versionnée pour agents » (tasks/plan/memory) n'est portée par personne.
2. **Symlinks d'abord, avec repli en copie synchronisée** — la douleur des symlinks sous Windows est documentée partout ; personne ne fait la détection d'environnement + bascule automatique.
3. **La génération d'`agents/openai.yaml` + icône SVG par skill** — zéro outil, alors que c'est ce qui rend un skill visible et soigné dans l'interface ChatGPT/Codex.
4. **Le générateur de hooks multi-harness** — les événements ont convergé, les trois fichiers d'enregistrement restent incompatibles ; `add hook` qui écrit le script une fois et l'enregistre trois fois n'existe nulle part.
5. **La génération des configurations worktrees/environnements** — `.cursor/worktrees.json` est documenté officiellement chez Cursor ; personne ne le génère.
6. **La migration `.claude/` → `.agents/`** — rulesync importe vers son format propriétaire ; personne ne migre vers la convention neutre que les harness lisent nativement. C'est le meilleur canal d'acquisition : la base installée de configurations Claude Code est énorme, et Claude Code est justement le harness qui ne lit pas le standard.

## 4. Les risques

1. **Vitesse d'évolution des harness.** ruler et rulesync maintiennent 30 à 40 adaptateurs ; les formats de hooks Cursor ont déjà cassé entre versions. Parade : ne cibler que 3-4 harness majeurs et s'appuyer sur les répertoires que les harness lisent déjà nativement — moins d'adaptateurs, moins de casse.
2. **Convergence des standards.** Si Claude Code adopte AGENTS.md nativement (demande forte, issues en doublon), la moitié « pont » de la valeur s'évapore ; il restera l'installation initiale, les générateurs et la migration. C'est un argument pour livrer maintenant, pendant que le pont fait mal.
3. **Espace encombré en apparence.** `npx skills` domine la distribution de skills, ruler et rulesync sont installés. Parade : interopérer, pas concurrencer — rester compatible avec les skills installés par `npx skills`, respecter la spec agentskills.io, laisser à rulesync/ruler la niche des 40 outils exotiques.
4. **Windows.** Le repli copie + synchronisation doit gérer les checkouts où les symlinks deviennent des fichiers texte contenant le chemin cible — piège documenté, premier rapport de bogue prévisible.

## 5. Positionnement et nom retenus

**Accroche** : « installe dans n'importe quel repo l'architecture d'agents que Codex, Cursor et opencode lisent déjà nativement — et fait le pont pour Claude Code. » Catégorie visée : installation d'architecture conforme aux standards, zéro dérive — encore vide. Catégorie à fuir : « synchroniseur de règles » — déjà prise et réductrice. L'angle éditorial « mémoire de projet versionnée pour agents » (tasks/plan/memory) n'est porté par aucun concurrent.

**Nom retenu : `agentsdir`** — libre sur npm (vérifié le 27/08/2026), il nomme littéralement la convention `.agents/` que la CLI installe, sans marque de vendeur. Alternatives libres au moment du relevé : `agentsmd`, `agentroot`, `agentground`. Écartés : tout nom contenant « rules », « sync » (catégories occupées) ou « skills » (espace de noms saturé par Vercel, Anthropic et OpenAI).

## 6. Sources

Standards et documentation officielle :

- https://agentskills.io/home et https://github.com/agentskills/agentskills — spécification Agent Skills
- https://developers.openai.com/codex/skills — skills Codex et `agents/openai.yaml`
- https://cursor.com/docs/context/skills et https://cursor.com/docs/configuration/worktrees — Cursor
- https://opencode.ai/docs/skills/ et https://opencode.ai/docs/rules/ — opencode
- https://code.claude.com/docs/en/hooks — hooks Claude Code
- https://developers.openai.com/codex/cloud/environments — environnements Codex cloud
- https://www.morphllm.com/agents-md-guide et https://codersera.com/blog/agents-md-complete-guide-2026/ — adoption d'AGENTS.md

Concurrents (étoiles relevées via l'API GitHub le 27/08/2026) :

- https://github.com/intellectronica/ruler · https://github.com/dyoshikawa/rulesync · https://github.com/vercel-labs/skills · https://github.com/davila7/claude-code-templates · https://github.com/anthropics/skills · https://github.com/openai/skills · https://github.com/block/ai-rules · https://github.com/steipete/agent-rules · https://github.com/udecode/dotai · https://github.com/antfu/skills-npm · https://github.com/mitkury/airul · https://github.com/luisrudge/dot-ai

Signaux de demande :

- https://news.ycombinator.com/item?id=44957443 (lancement AGENTS.md, 837 points) · https://news.ycombinator.com/item?id=47034087
- https://github.com/anthropics/claude-code/issues/34235 — demande de support AGENTS.md dans Claude Code
- https://aq.dev/guides/keep-agents-md-and-claude-md-in-sync/ — douleur de la synchronisation manuelle
- https://lobehub.com/skills/neversight-learn-skills.dev-agent-symlink-init — un skill qui symlinke `.claude/skills` sur `.agents/skills` (le geste, sans l'outil)

Guides hooks :

- https://codex.danielvaughan.com/2026/04/15/codex-cli-hooks-complete-guide-events-policy-patterns/ · https://ntorres.dev/blog/cursor-hooks-json-guide · https://blog.gitbutler.com/cursor-hooks-deep-dive · https://www.hookstack.app/guides/openai-codex-hooks
