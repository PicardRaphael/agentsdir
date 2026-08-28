# Stratégie de test

Les tiers de tests retenus, les conventions de nommage, comment lancer chaque niveau, et ce qui n'est volontairement pas testé.

## Tiers retenus

| Tier | Portée | Outil | Emplacement |
| --- | --- | --- | --- |
| Unitaire / smoke | Fonctions pures et traversée complète de la CLI compilée (`node dist/cli.js`) | Vitest | `src/**/__tests__/*.test.ts` |
| Bout en bout (e2e) | Scénarios complets (`init`, `check`, `sync`) sur des repos de démonstration TypeScript et Python, dans les deux modes (symlink et copie) | Vitest | `e2e/` — n'existe pas encore, arrive avec la tâche de release v1.0 |

Le smoke test « walking skeleton » garantit que la chaîne build + test existe avant toute feature : `node dist/cli.js --help` traverse parseur → sortie.

## Conventions de nommage

- Les noms des tests reprennent les critères d'acceptation des tâches au format Given/When/Then (règle : [.agents/rules/code-conventions.md](.agents/rules/code-conventions.md)).
- Les noms sont rédigés en anglais — la langue du produit, comme les messages de la CLI — en reformulant les critères d'acceptation français. Le `describe` porte le numéro de la tâche d'origine pour la traçabilité.
- Fichiers de test : `*.test.ts` dans un dossier `__tests__/` à côté du code testé.
- Les tests écrivent dans des répertoires temporaires, jamais dans le repo.

## Lancer chaque niveau

| Commande | Effet |
| --- | --- |
| `npm test` | Construit le bundle (`pretest`) puis lance tous les tests Vitest. |
| `npm run typecheck` | `tsc --noEmit` en mode strict. |
| `npm run lint` | ESLint puis `prettier --check` — bloquants, en local comme en CI. |
| `npm run build` | Bundle unique `dist/cli.js` via tsup. |

La CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) enchaîne typecheck → lint → test → build sur ubuntu-latest **et** windows-latest. La CI Windows n'est pas optionnelle : le mode copie (repli) doit y passer sans symlinks.

## Ce qu'on ne teste pas (décisions explicites)

- **Le texte exact de l'aide** : on vérifie la traversée (nom du binaire, section usage, code de sortie), pas la mise en forme — elle appartient au parseur (citty).
- **Les dépendances elles-mêmes** (citty) : on teste le comportement d'agentsdir, pas leurs internes.
- **macOS en CI** : ubuntu couvre le mode symlink, windows couvre le mode copie (repli) ; macOS n'apporterait aucun cas supplémentaire.
- **Aucun seuil de couverture** : la mesure de livraison est la satisfaction des critères d'acceptation des tâches, pas un pourcentage.
- **L'interactivité `@clack/prompts`** : les tests passent par `--yes` ou par le repli non-TTY (défauts) ; le rendu et la navigation des questions appartiennent à la bibliothèque.
