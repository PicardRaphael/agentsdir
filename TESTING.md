# Stratégie de test

Les tiers de tests retenus, les conventions de nommage, comment lancer chaque niveau, et ce qui n'est volontairement pas testé.

## Tiers retenus

| Tier | Portée | Outil | Emplacement |
| --- | --- | --- | --- |
| Unitaire / smoke | Fonctions pures et traversée complète de la CLI compilée (`node dist/cli.js`) | Vitest | `src/**/__tests__/*.test.ts` |
| Bout en bout (e2e) | Scénarios complets (`init --yes` → `add skill` → `check`, interop `npx skills`, création assistée scriptée) sur des repos de démonstration TypeScript et Python, dans les deux modes (symlink et copie) | Vitest (`vitest.e2e.config.ts`) | `e2e/` |

Le smoke test « walking skeleton » garantit que la chaîne build + test existe avant toute feature : `node dist/cli.js --help` traverse parseur → sortie.

## Socle partagé des tests

`src/test-support/index.ts` porte ce dont chaque fichier de test a besoin pour
piloter la CLI : `makeTempDir(prefix)` (répertoire jetable, nettoyé par un
`afterEach` interne au module), `runCli(cwd, args)` (exécute le binaire compilé,
un code de sortie non nul est un résultat, pas une exception), `initAnswers()`
(les réponses que `init --yes` collecterait, surchargeables) et `pathExists`.

Ces helpers vivaient auparavant en seize exemplaires. Les garder en un seul
endroit signifie qu'un changement de contrat — un champ de plus dans
`InitAnswers`, une autre convention de code de sortie — se fait une fois. Un
fichier de test qui a besoin d'un comportement différent passe des overrides
(`initAnswers({ stacks: ["node"] })`) plutôt que de redéclarer sa propre
fabrique.

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
| `npm run test:e2e` | Construit le bundle puis lance les scénarios de `e2e/` contre la CLI compilée. |

La CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) enchaîne typecheck → lint → test → build → test:e2e sur ubuntu-latest **et** windows-latest. La CI Windows n'est pas optionnelle : le mode copie (repli) doit y passer sans symlinks. Les scénarios e2e en mode symlink se désactivent d'eux-mêmes (sonde `detectSymlinkSupport`) là où les symlinks sont indisponibles : ubuntu prouve le mode symlink, windows prouve le mode copie.

## Les garde-fous : la mutation comme mesure

Un test qui passe aussi bien avec que sans la garde qu'il prétend couvrir ne
prouve rien — c'est ce qui a permis à quatre évasions par lien symbolique de
survivre à une suite verte. Tout test de garde-fou est donc validé par
mutation : la garde retirée, il doit échouer. La preuve (sortie rouge, sortie
verte) est collée dans le message de commit qui l'introduit.

| Garde | Test | Ce que la mutation retire |
| --- | --- | --- |
| Contrat `--json` en cas d'échec, pour les neuf commandes qui exposent le drapeau | `src/commands/__tests__/json-failure-contract.test.ts` | la branche `if (json)` du `catch` de `check`, `sync`, `doctor` et `runGeneratorCli` |
| Marqueurs de commentaire neutralisés dans la première ligne d'une règle | `src/commands/__tests__/rules-index-injection.test.ts` | `sanitizeHook` (`src/templates/agents-md.ts`) |
| Clé de `skills-lock.json` refusée comme segment de chemin | `src/core/__tests__/lock-key-escape.test.ts` | le filtre `NAME_SPEC` sur la clé (`src/core/validate.ts`) |
| Sept règles de `check` : `skill-frontmatter`, `skill-md-missing`, `skill-md-unreadable`, `skill-name-spec`, `skill-unknown-icon`, `agents-md-missing`, `rules-index-missing` | `src/commands/__tests__/check-untested-rules.test.ts` | la branche qui pousse la violation |

Le contrat `--json` passe par la CLI compilée : une mutation dans `src/` n'y est
visible qu'après `npm run build`. Sans ce build, le test reste vert et la preuve
de mutation est fausse.

## Ce qu'on ne teste pas (décisions explicites)

- **Le texte exact de l'aide** : on vérifie la traversée (nom du binaire, section usage, code de sortie), pas la mise en forme — elle appartient au parseur (citty).
- **Les dépendances elles-mêmes** (citty) : on teste le comportement d'agentsdir, pas leurs internes.
- **macOS en CI** : ubuntu couvre le mode symlink, windows couvre le mode copie (repli) ; macOS n'apporterait aucun cas supplémentaire.
- **Aucun seuil de couverture** : la mesure de livraison est la satisfaction des critères d'acceptation des tâches, pas un pourcentage.
- **L'interactivité `@clack/prompts`** : les tests passent par `--yes` ou par le repli non-TTY (défauts) ; le rendu et la navigation des questions appartiennent à la bibliothèque.
- **Quatre règles de `check` restent sans test qui les nomme** : `agent-unreadable`, `lock-skill-missing`, `projection-missing` et `projection-header-removed`. Aucun test ne déclenche ces quatre-là en vérifiant leur message ; c'est un trou connu, pas une décision.
- **Le doublon de garde de `planLock` (`src/commands/sync.ts`)** : le filtre `NAME_SPEC` y est une ceinture par-dessus les bretelles de `validateRepo`, qui refuse la clé avant que `sync` ne planifie quoi que ce soit. Le retirer ne peut faire échouer aucun test — la garde observable est celle de `src/core/validate.ts`, et c'est elle que la mutation prouve.
