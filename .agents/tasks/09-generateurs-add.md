# 09 — Générateurs `add skill`, `add rule`, `add agent`

Dépend de : 06, 07

## Problème

Ajouter un skill, une règle ou un sous-agent doit être une commande, pas un copier-coller : c'est ce qui maintient les invariants vrais dans la durée.

## Fichiers

- `src/commands/add-skill.ts`, `add-rule.ts`, `add-agent.ts` + tests
- Gabarits dans `src/templates/`

## Critères d'acceptation

- `add skill <name>` : valide le nom (kebab-case, unique), crée `.agents/skills/<name>/SKILL.md` avec frontmatter étendu complet (questions interactives : description « Use when… », nom affiché, couleur, icône avec aperçu des noms valides, prompt par défaut) et un corps guidé d'au moins 12 lignes significatives ; `disable-model-invocation: true` par défaut ; `--implicit` refusé sauf déclaration explicite que le skill est en lecture seule ; génère immédiatement `agents/openai.yaml` + `assets/icon.svg` ; `check` passe juste après.
- `add rule <name>` : crée `.agents/rules/<name>.md` au gabarit (H1, ton impératif, sections GOOD/BAD, tableau si pertinent), `--paths "<glob>"` ajoute le frontmatter de scope ; met à jour l'index des règles d'`AGENTS.md` (bloc géré) avec la ligne « chemin — quand la lire » demandée interactivement.
- `add agent <name>` : crée `.agents/agents/<name>.md` (frontmatter `name`, `description`, `color`, `model` + prompt système gabarit).
- Les trois commandes sont idempotentes en échec (nom déjà pris → exit 2, rien d'écrit) et supportent `--dry-run`.

## Vérification

```bash
npm test -- add
```

## Hors périmètre

`add hook` (tâche 10, format d'enregistrement différent par harness).
