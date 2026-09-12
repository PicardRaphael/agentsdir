# Stratégie de test

Les tiers de tests retenus, les conventions de nommage, comment lancer chaque niveau, et ce qui n'est volontairement pas testé.

## Tiers retenus

| Tier | Portée | Outil | Emplacement |
| --- | --- | --- | --- |
| Unitaire / smoke | Fonctions pures et traversée complète de la CLI compilée (`node dist/cli.js`) | Vitest | `src/**/__tests__/*.test.ts` |
| Bout en bout (e2e) | Scénarios complets (`init --yes` → `add skill` → `check`, interop `npx skills`, création assistée scriptée, proposition d'ensemble déroulée en réponses scriptées) sur des repos de démonstration TypeScript et Python, dans les deux modes (symlink et copie) | Vitest (`vitest.e2e.config.ts`) | `e2e/` |
| Validation par un agent réel (manuel) | Ce qu'un test ne peut pas observer : un harness charge-t-il vraiment ce que la CLI écrit — skill découvert, sous-agent délégable, hook déclenché, `AGENTS.md` lu | Une session réelle du harness, conduite par un scénario versionné | `e2e/validation-agent/` |

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
| Contrat `--json` en cas d'échec, pour les dix commandes qui exposent le drapeau | `src/commands/__tests__/json-failure-contract.test.ts` | la branche `if (json)` du `catch` de `check`, `sync`, `update`, `doctor` et `runGeneratorCli` |
| Marqueurs de commentaire neutralisés dans la première ligne d'une règle | `src/commands/__tests__/rules-index-injection.test.ts` | `sanitizeHook` (`src/templates/agents-md.ts`) |
| Clé de `skills-lock.json` refusée comme segment de chemin | `src/core/__tests__/lock-key-escape.test.ts` | le filtre `NAME_SPEC` sur la clé (`src/core/validate.ts`) |
| Le schéma du manifeste n'avance que par `update` | `src/commands/__tests__/update.test.ts` | la préservation `schema: manifest.schema` dans `planManifest` (`src/commands/sync.ts`) |
| Aucun écrasement silencieux d'un contenu installé puis modifié localement | `src/commands/__tests__/update.test.ts` | la branche qui classe l'entrée en conflit au lieu de la mettre à niveau (`src/commands/update.ts`) |
| Le contenu vendorisé (`sourceType: "github"`) n'est jamais mis à niveau | `src/commands/__tests__/update.test.ts` | le filtre `sourceType === "agentsdir"` de `collectInstalled` |
| Le contenu écrit par l'utilisateur n'est jamais réécrit | `src/commands/__tests__/update.test.ts` | la limitation des suppressions à `entry.onDisk` dans `applyUpgrade` |
| Le plan de `--dry-run` est celui que le vrai passage exécute | `src/commands/__tests__/update.test.ts` | le `sourceOverlay` remis au `sync` du passage à blanc, puis la cohérence `planWrites`/`applyUpgrade` |
| Un refus de fusion enregistre la version refusée, jamais les octets locaux | `src/commands/__tests__/update.test.ts` | l'écriture de `declinedHash` à côté d'un `computedHash` laissé intact dans `planLock` |
| Une fusion refusée n'est pas reproposée jusqu'à ce que l'amont bouge encore | `src/commands/__tests__/update.test.ts` | la branche `entry.upstream === entry.declined` du classement |
| Un refus ne fait pas taire les versions amont suivantes | `src/commands/__tests__/update.test.ts` | l'égalité de cette même branche, plutôt qu'un simple test de présence |
| Un `update` qui échoue échoue sur un dépôt intact | `src/commands/__tests__/update.test.ts` | la `sync` planifiée à blanc avant la première écriture, et sa garde sur les violations |
| Une marche de schéma non déclarée arrête la migration | `src/core/__tests__/migrations.test.ts` | le `throw` sur l'étape absente (`src/core/migrations.ts`) |
| En-tête généré placé après le frontmatter d'une projection Markdown | `src/core/__tests__/projections.test.ts` | la consultation de `frontmatterBlockLength` dans `decorateMarkdown` (`src/core/projections.ts`), qui replace l'en-tête devant le bloc |
| Sept règles de `check` : `skill-frontmatter`, `skill-md-missing`, `skill-md-unreadable`, `skill-name-spec`, `skill-unknown-icon`, `agents-md-missing`, `rules-index-missing` | `src/commands/__tests__/check-untested-rules.test.ts` | la branche qui pousse la violation |
| Un positionnel requis manquant sort en `2` (usage), pas en `1` (dérive) | `src/__tests__/missing-argument.test.ts` | la garde `missingArgument` branchée dans `src/cli.ts` (`src/command-tree.ts`) |
| Le refus d'un générateur (nom pris, manifeste absent) précède la première question | `src/commands/__tests__/generator-guards.test.ts` | l'appel à `ensureWritable` placé avant l'interview (`src/commands/add-common.ts`) |
| Chaque question d'interview des générateurs a un drapeau, et un drapeau vide est refusé par son nom | `src/commands/__tests__/generator-flags.test.ts` | les drapeaux déclarés et la table `SKILL_RULES` partagée par la question et le drapeau (`src/commands/add-skill.ts`) |
| `init --json` écrit un objet unique sur stdout, sans question mêlée au flux | `src/commands/__tests__/init-json.test.ts` | la déclaration du drapeau et la bascule `yes: args.yes === true || json` (`src/commands/init.ts`) |
| Aucune commande écrite dans `AGENTS.md` sans preuve dans le dépôt | `src/core/__tests__/stack-evidence.test.ts` | la lecture des scripts et outils déclarés, qui redevient une suggestion codée en dur (`src/core/detect.ts`) |
| Le bloc de permissions géré de `.claude/settings.json` couvre les scripts des packs installés | `src/commands/__tests__/claude-permissions.test.ts` | le calcul des règles attendues dans `applyPermissions` (`src/core/claude-permissions.ts`) |

Le contrat `--json` passe par la CLI compilée : une mutation dans `src/` n'y est
visible qu'après `npm run build`. Sans ce build, le test reste vert et la preuve
de mutation est fausse.

## Le tier manuel : la validation par un agent réel

Les deux premiers tiers prouvent que les bons octets arrivent aux bons endroits.
Ils ne prouvent pas qu'un harness **charge** ce que la CLI écrit. Un `check`
vert dit que le fichier est conforme au rendu attendu ; il ne dit pas qu'un
skill est découvert, qu'un sous-agent est proposé à la délégation, qu'un hook
se déclenche, ni qu'`AGENTS.md` est lu. Personne ne comble cet écart avec un
test automatisé classique : il faut une session réelle, sur un dépôt
fraîchement installé.

Ce n'est pas théorique. La première exécution, le 12 septembre 2026, a trouvé
un défaut qu'aucun test de la suite automatisée ne voyait : en mode copie, l'en-tête généré
passait devant le frontmatter, et Claude Code cessait alors de découvrir les
sous-agents et de lire les métadonnées des skills — projections conformes,
`check` vert, harness aveugle.

- **Le scénario** : [e2e/validation-agent/prompt.md](e2e/validation-agent/prompt.md).
  Versionné, reproductible, il énonce ce qui est observé, comment le consigner,
  et les pièges de conduite d'une sous-session qui fausseraient les verdicts.
- **Les comptes rendus** : [e2e/validation-agent/rapports/](e2e/validation-agent/rapports/),
  un par exécution, nommés `AAAA-MM-JJ-<harness>.md`.
- **Fréquence** : après une release, et après tout changement touchant les
  projections, le frontmatter, les hooks ou les templates des générateurs.
- **Coût** : une trentaine de minutes, deux terrains compris — un dépôt neuf
  pour la reproductibilité, un clone de dépôt réel pour le cas qu'aucun test ne
  couvre.

Automatiser la conduite d'un agent réel en CI est hors de question : coûteux,
fragile, dépendant de services tiers. Ce tier reste manuel et peu fréquent,
assumé comme tel. Son résultat, en revanche, n'est pas facultatif : tout écart
constaté devient une tâche de `.agents/tasks/` ou un correctif.

## Ce qu'on ne teste pas (décisions explicites)

- **Le texte exact de l'aide** : on vérifie la traversée (nom du binaire, section usage, code de sortie), pas la mise en forme — elle appartient au parseur (citty).
- **Les dépendances elles-mêmes** (citty) : on teste le comportement d'agentsdir, pas leurs internes.
- **macOS en CI** : ubuntu couvre le mode symlink, windows couvre le mode copie (repli) ; macOS n'apporterait aucun cas supplémentaire.
- **Aucun seuil de couverture** : la mesure de livraison est la satisfaction des critères d'acceptation des tâches, pas un pourcentage.
- **L'interactivité `@clack/prompts`** : les tests passent par les drapeaux, par `--yes` ou par le repli non-TTY (défauts) ; le rendu et la navigation des questions appartiennent à la bibliothèque.
- **Quatre règles de `check` restent sans test qui les nomme** : `agent-unreadable`, `lock-skill-missing`, `projection-missing` et `projection-header-removed`. Aucun test ne déclenche ces quatre-là en vérifiant leur message ; c'est un trou connu, pas une décision.
- **Le doublon de garde de `planLock` (`src/commands/sync.ts`)** : le filtre `NAME_SPEC` y est une ceinture par-dessus les bretelles de `validateRepo`, qui refuse la clé avant que `sync` ne planifie quoi que ce soit. Le retirer ne peut faire échouer aucun test — la garde observable est celle de `src/core/validate.ts`, et c'est elle que la mutation prouve.
