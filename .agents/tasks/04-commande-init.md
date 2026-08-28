# 04 — Commande `init`

Dépend de : 02, 03

## Problème

La commande fondatrice : installer l'architecture dans un repo existant, quel que soit son langage, sans rien écraser.

## Fichiers

- `src/commands/init.ts` + tests d'intégration (répertoires temporaires)
- Gabarits embarqués dans `src/templates/` (AGENTS.md, règles génériques, tasks/README.md, modèle `.agents/memory.template/`)

## Critères d'acceptation

- Interactif par défaut (`@clack/prompts`) : nom du produit, description, confirmation des commandes détectées (dev/test/lint), harness (défaut : les trois), packs (défaut : `core` + `creator`). `--yes` prend tous les défauts ; `--dry-run` liste les écritures sans toucher au disque ; `--harness` et `--packs` court-circuitent les questions.
- Génère : `.agents/{rules,skills,agents,tasks,plan,memory}` avec fichiers d'amorçage, `AGENTS.md` (structure trois familles : sections génériques remplies, sections stack pré-remplies depuis la détection, sections produit avec les réponses de l'utilisateur), entrées `.gitignore` (`/.agents/memory/`, `/.agents/output/`), `.gitattributes` (eol=lf) s'il n'existe pas, workflow CI `agents-check.yml` (`npx agentsdir check`), manifeste `.agents.toml`.
- **Additif** : si `AGENTS.md` existe déjà, la CLI n'écrit que ses blocs gérés (`<!-- agentsdir:begin <id> -->` / `<!-- agentsdir:end <id> -->`) et n'altère jamais le reste ; si `.gitignore` existe, elle ajoute ses lignes sans dédoublonner celles de l'utilisateur ; aucun fichier utilisateur n'est écrasé, jamais.
- Idempotent : relancer `init` sur un repo déjà initialisé ne change rien (exit 0, message « déjà initialisé — utiliser `sync` pour régénérer »).
- Le conseil de sortie affiche les prochaines étapes (`add skill`, `check`).

## Notes d'implémentation

Se conformer à `docs/commandes.md` (spécification et diagramme du flux). Les projections elles-mêmes (CLAUDE.md, .claude/*) sont branchées en 05 — `init` les appelle.

## Vérification

```bash
npm test -- init
# puis autophagie :
node dist/cli.js init --dry-run   # exécuté à la racine de CE repo
```

## Hors périmètre

Le contenu des packs (11, 12) ; la migration d'un `.claude/` existant (v2).
