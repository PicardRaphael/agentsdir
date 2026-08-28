# 16 — Méta-skill `$setup-context` (AGENTS.md parfait)

Dépend de : 15

## Problème

Un AGENTS.md parfait ne peut pas sortir d'un simple questionnaire : il faut analyser le repo (commandes réelles, conventions, configs concurrentes) puis ne demander à l'utilisateur que le non-découvrable. C'est `/init` de Claude Code, en multi-harness, avec critique et validation mécanique.

## Fichiers

- `src/packs/creator/skills/setup-context/` — SKILL.md + `references/rubrique.md` + `references/interview.md`

## Critères d'acceptation

- **Inventaire** : la méta-skill fait explorer le repo par l'agent — scripts de build/test/lint réels, structure, conventions observées — et inventorie les configs existantes (CLAUDE.md, AGENTS.md, `.cursor/rules`, `.cursorrules`, `.github/copilot-instructions.md`) pour les importer, jamais les écraser.
- **Interview** limitée au non-découvrable (banque de `docs/creation-assistee.md`) : commandes interdites, échecs récents de l'agent, conventions divergentes des réglages par défaut de l'écosystème, ce qui est déjà appliqué mécaniquement, monorepo.
- **Rédaction** dans la structure trois familles (génériques / stack / produit) via les blocs gérés d'AGENTS.md ; ce qui est appliqué par linter/CI/hooks est exclu du fichier.
- **Critique** : passe ligne à ligne avec la question-filtre ; proposition révisable présentée à l'utilisateur avant écriture.
- Fonctionne sur un AGENTS.md existant (mode amélioration : propose des changements, ne réécrit pas les sections de l'utilisateur) comme sur un repo vierge.
- Se termine par `agentsdir check` et par la suggestion des prochaines étapes (`$create-skill`, `$create-hook`).
- Enregistré dans `skills-lock.json` (`sourceType: "agentsdir"`) comme le reste du pack `creator`.

## Vérification

```bash
npm test -- setup-context
```

## Hors périmètre

L'import automatique *sans* agent IA (la CLI seule ne fait que la détection basique de la tâche 02) ; la migration complète `.claude/` → `.agents/` (v2, commande `migrate`).
