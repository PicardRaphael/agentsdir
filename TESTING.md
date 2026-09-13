# Stratégie de test

Les tiers de tests retenus, les conventions de nommage, comment lancer chaque niveau, et ce qui n'est volontairement pas testé.

## Tiers retenus

| Tier | Portée | Outil | Emplacement |
| --- | --- | --- | --- |
| Unitaire / smoke | Fonctions pures et traversée complète de la CLI compilée (`node dist/cli.js`) | Vitest | `src/**/__tests__/*.test.ts` |
| Bout en bout (e2e) | Scénarios complets (`init --yes` → `add skill` → `check`, interop `npx skills`, création assistée scriptée, proposition d'ensemble déroulée en réponses scriptées, collecte d'usage jouée avec les payloads des trois harness) sur des repos de démonstration TypeScript et Python, dans les deux modes (symlink et copie) | Vitest (`vitest.e2e.config.ts`) | `e2e/` |
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
| `npm run test:coverage` | Construit le bundle puis lance Vitest avec la couverture v8 : tableau lisible en CI et `coverage/coverage-summary.json` pour un suivi dans le temps. |

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
| Une règle sans `paths:` est payée à **chaque** session, une règle scopée seulement quand elle est pertinente | `src/core/__tests__/context-budget.test.ts` | le ternaire `hasScope(source)` de `measureRules` (`src/core/context-budget.ts`) |
| Le coût de démarrage d'un skill est `name` + `description`, jamais le frontmatter entier | `src/core/__tests__/context-budget.test.ts` | la chaîne mesurée dans `measureSkills` |
| Seule la source de vérité est comptée : les projections `.claude/**` ne doublent aucun chiffre | `src/core/__tests__/context-budget.test.ts` | les racines énumérées par `measureContextBudget` |
| Un corps de `SKILL.md` trop lourd en tokens est signalé même sous 500 lignes | `src/core/__tests__/context-budget.test.ts`, `src/commands/__tests__/doctor.test.ts` | la borne `bodyItem.tokens > MAX_BODY_TOKENS` |
| Un dépassement de budget informe : `doctor` sort en `0` et `check` ne bronche pas | `src/commands/__tests__/doctor.test.ts` | l'`exitCode: EXIT_CODES.ok` de `runDoctor`, et l'absence de règle de budget dans `validateRepo` |
| Le total payé à chaque session est distingué du total général, jusque dans la ligne de synthèse | `src/commands/__tests__/doctor.test.ts` | `contextBudgetFinding` (`src/commands/doctor.ts`) |
| Le terminal montre les éléments les plus lourds d'abord, `--json` les porte tous | `src/commands/__tests__/doctor.test.ts` | le tri de `renderContextBudget` et le champ `items` de `machineContext` |
| Sous le seuil de volume, aucune absence n'est conclue — et le refus n'est pas adouci en suggestion | `src/commands/__tests__/pack-usage-review.test.ts` | le `conclusive` de `measureVolume` et la branche de `renderNeverSeen` |
| Le seuil exige **20 sessions ET 14 jours distincts**, pas l'un ou l'autre | `src/commands/__tests__/pack-usage-review.test.ts` | la conjonction de `measureVolume`, testee aux deux bords |
| Ce qui a servi est rapporte quel que soit le volume : une presence se prouve sur une ligne | `src/commands/__tests__/pack-usage-review.test.ts` | `renderUsed`, hors de la garde de seuil |
| Une regle sans `paths:` va en « ce qu'on ne peut pas dire », jamais en « jamais pertinente » | `src/commands/__tests__/pack-usage-review.test.ts` | `ruleBucket` et la branche `unscoped` de `renderLimits` |
| Les regles sont dites pertinentes, jamais utilisees ni lues | `src/commands/__tests__/pack-usage-review.test.ts` | le vocabulaire de `renderRules`, greppe sur le Markdown rendu |
| Le coût croise est celui de l'element lui-meme, par session et par invocation separement | `src/commands/__tests__/pack-usage-review.test.ts` | `skillCost` et `pathCost`, compares aux items de `doctor` |
| Un coût non mesure est rapporte comme non mesure, jamais comme nul | `src/commands/__tests__/pack-usage-review.test.ts` | le `null` de `skillCost` et la ligne de `renderLimits` |
| Des delegations sans nom d'agent sont signalees au lieu d'un zero trompeur | `src/commands/__tests__/pack-usage-review.test.ts` | `unnamedDelegations` et sa branche dans `renderLimits` |
| Une ligne JSONL tronquee est ignoree, pas fatale | `src/commands/__tests__/pack-usage-review.test.ts` | le `catch` de `readJournal` |
| Le script de revue n'ecrit rien | `src/commands/__tests__/pack-usage-review.test.ts` | empreinte de l'arbre avant/apres |
| La traversee trie en unites de code, jamais par locale | `src/core/__tests__/walk-files.test.ts` | le comparateur de `walkFiles` (`src/core/fs-utils.ts`), dont depend l'ordre des empreintes |
| Les exclusions d'empreinte viennent de l'appelant, pas d'un rappel en dur | `src/core/__tests__/walk-files.test.ts` | `SKILL_HASH_EXCLUDED` passe a `walkFiles` (`src/core/skill-hash.ts`) |
| Un repertoire absent et un repertoire illisible ne se ressemblent pas, dans la traversee partagee | `src/core/__tests__/walk-files.test.ts` | la branche `options.unreadable` de `walkFiles` |
| Un manifeste illisible se dit illisible, pas absent | `src/core/__tests__/exact-diagnostics.test.ts` | la branche non-ENOENT de `readManifest` (`src/core/manifest.ts`) |
| `doctor` diagnostique un manifeste illisible au lieu de sortir en 2 | `src/core/__tests__/exact-diagnostics.test.ts` | le `ManifestError` que `runDoctor` sait rapporter |
| Une cible de projection illisible n'est pas ecrasee comme si elle etait absente | `src/core/__tests__/exact-diagnostics.test.ts` | `unreadableTarget` dans `classifyCopyTarget`/`classifyLinkTarget` |
| Une metadonnee `agentsdir:hook` cassee est nommee, pas ignoree | `src/core/__tests__/exact-diagnostics.test.ts` | `hookMetadataProblem` et la regle `hook-metadata-invalid` |
| Aucun module hors `core/manifest.ts` ne rend ni n'ecrit `.agents.toml` | `src/core/__tests__/manifest-gate.test.ts` | balayage des sources, comme `layering.test.ts` |
| Aucune section optionnelle du manifeste n'est perdue par `sync`, `pack add` ou `pack remove` | `src/core/__tests__/manifest-gate.test.ts` | le `...manifest` de `planManifest` (`src/commands/sync.ts`), au lieu d'une liste de champs |
| Le plan `--dry-run` du manifeste annonce ce que l'execution reelle ecrit, y compris "rien" | `src/core/__tests__/manifest-gate.test.ts` | `planManifest` (`src/core/manifest.ts`), partage par les deux chemins |
| Aucun module hors `core/lock.ts` n'ecrit `skills-lock.json` | `src/core/__tests__/lock-gate.test.ts` | balayage des sources |
| Une entree `agentsdir` reste epinglee, une entree `github` est re-verrouillee | `src/core/__tests__/lock-gate.test.ts` | `relockVendored` (`src/core/lock.ts`) |
| Le meme etat declare donne les memes octets, atteint par `init` ou par `pack add` | `src/core/__tests__/lock-gate.test.ts` | `renderLock` et son tri par cle |
| Un verrou malforme ou non-objet est refuse, jamais relu comme vide | `src/core/__tests__/lock-gate.test.ts` | `parseLock` |
| `add hook` interrompu laisse un etat que `check` voit et que `sync` repare | `src/core/__tests__/interrupted-sequence.test.ts` | l'invariant 17 (`hook-registration-drift`) et le replanificateur de `sync` |
| Aucune commande n'ecrit hors de `writeFileAtomic` | `src/core/__tests__/interrupted-sequence.test.ts` | balayage de `src/commands/` |
| Un registre tronque fait refuser `sync` sans rien ecrire | `src/core/__tests__/interrupted-sequence.test.ts` | `hook-registry-invalid`, verifie avant la premiere ecriture |
| Le support d'evenement derive des declarations reproduit exactement l'ancienne table, evenement par evenement | `src/core/__tests__/harness-declaration.test.ts` | `harnessEventKey` (`src/core/harnesses.ts`) |
| Aucun module ne decide d'un comportement en nommant un harness | `src/core/__tests__/harness-declaration.test.ts` | balayage de `src/`, apres le remplacement des gardes `includes("claude")` |
| Les douze evenements ne portent plus rien par harness | `src/core/__tests__/harness-declaration.test.ts` | `HOOK_EVENTS` reduit au nom canonique |

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

## L'injection de pannes

Aucun test ne simulait une écriture qui échoue, et c'est par ce trou que l'audit d'architecture est passé : ses cinq défauts vivaient tous sur un chemin d'erreur, et aucun de ces chemins n'était exécuté.

**Le procédé est une seule fonction partagée**, `makeUnreadable` (`src/test-support/index.ts`) : elle échange la nature du chemin — un fichier là où un répertoire est attendu (`ENOTDIR` sur `readdir`), un répertoire là où un fichier est attendu (`EISDIR` sur `readFile`) — et rend l'annulation, pour qu'un test prouve aussi que le dépôt redevient sain une fois la cause retirée.

Deux choses ont été écartées, et pour la même raison : `chmod` ne produit rien sous Windows, où la CI tourne aussi, et une garde prouvée sur une plateforme n'est pas prouvée ; un mock de `node:fs` testerait le mock. Le procédé retenu marche partout et exerce le vrai code errno, que les diagnostics inspectent désormais (tâche 22).

**Chaque commande qui écrit a son test de panne** (`src/commands/__tests__/write-failures.test.ts`), et chacun vérifie les trois choses qu'un utilisateur constate : le code de sortie, le message, et l'état du dépôt après l'échec — `init`, `sync`, `add rule`, `add skill`, `add agent`, `add hook`, `pack add`, `pack remove`, `update`.

## La couverture : ce qu'elle mesure, et ce qu'elle ne mesure pas

`npm run test:coverage` produit le tableau et `coverage/coverage-summary.json`. **Aucun seuil bloquant** : la décision est inchangée (voir plus bas), et un pourcentage se gagne avec des tests qui exécutent des lignes sans rien affirmer.

Au 13 septembre 2026 : **86 % des instructions, 75 % des branches**.

**Le plafond est là, et il est assumé.** Ce qui reste non couvert est de quatre natures, toutes tranchées ci-dessous : le câblage citty, les questions `@clack/prompts`, les sorties console et les branches défensives. Chaque point au-delà exigerait de tester un mock ou un import — c'est-à-dire d'écrire des tests qui n'affirment rien, pour contredire les décisions de ce document. 100 % n'est pas un objectif ici ; ce qui en est un, c'est qu'aucune ligne que l'utilisateur lit ou heurte ne reste sans test, et c'est fait.

Les fichiers les moins couverts, avec la décision prise pour chacun :

| Fichier | Couverture | Décision |
| --- | --- | --- |
| `src/cli.ts` | 0 % | **Assumé.** C'est le câblage citty ; il n'est jamais importé en test, il est exécuté en sous-processus par les tests du contrat `--json` et par `e2e/`. Le couvrir en mémoire mesurerait l'import, pas la traversée. |
| `src/commands/init-interview.ts` | 0 % | **Assumé.** Les questions `@clack/prompts` n'ont pas de chemin non interactif : les tests passent par les drapeaux et par le repli non-TTY, décision déjà prise plus bas. Chaque question a son drapeau, et c'est le drapeau qui est testé (`generator-flags.test.ts`). |
| `src/core/errors.ts` | 20 % | **Assumé.** Les branches non couvertes sont la traduction d'erreurs filesystem que le code appelant attrape avant d'arriver là ; leur sortie est vérifiée par le contrat `--json` en sous-processus. |
| `src/core/repo.ts` | 20 % | **Assumé.** Cinq lignes qui appellent `git rev-parse` ; l'échec est couvert par `json-failure-contract.test.ts`, en sous-processus. |
| `src/commands/check.ts` | 21 % | **Assumé, même raison que `cli.ts`** : la logique est dans `core/validate.ts` (94 %), le fichier n'est que la commande citty. |
| `src/commands/add-skill.ts` | 45 % | **Assumé.** Ce qui reste est l'interview et le câblage de la commande ; `runAddSkill` est couverte par `add-skill.test.ts` et par le test de panne, et la table `SKILL_RULES` — les six refus qu'un utilisateur rencontre en se trompant de drapeau — par `flag-validation.test.ts` depuis le 13 septembre 2026. |
| `src/commands/add-agent.ts`, `add-rule.ts`, `add-common.ts` | 37 à 63 % | **Assumé, même partage** : interview et commande non couvertes, fonction `run*` couverte, validateurs de drapeaux et `renderGeneratorReport` couverts. |
| `src/commands/init.ts` | 78 % | **Assumé.** `runInit` est couverte de bout en bout par `init.test.ts` et la base d'empreintes ; `renderReport` — le premier écran du produit — l'est depuis le 13 septembre 2026. Ce qui reste est le bloc citty `run()` et le repli non-TTY de l'interview. |
| `src/commands/update.ts` | 84 % | **Couvert le 13 septembre 2026.** `renderUpdateReport` et `mergeChanges` — le texte que l'utilisateur lit et la règle de fusion qui le nourrit — ont leurs tests directs (`src/commands/__tests__/reports.test.ts`), branche d'abandon et conflits non tranchés compris. Reste `askResolver` (prompts, assumé comme `init-interview`) et le bloc citty `run()` (exercé en sous-processus). |
| `src/commands/sync.ts` | 88 % | **Couvert le 13 septembre 2026.** `renderSyncReport` a ses tests directs, abandon sur invariants compris. Reste le bloc citty `run()`, assumé comme `cli.ts`. |

Les deux dernières lignes appelaient du travail ; il a été fait le 13 septembre 2026. Ce qui reste non couvert dans ces deux fichiers est assumé pour les raisons déjà écrites plus haut — les prompts et le câblage citty — et le couvrir en mémoire contredirait ces décisions au lieu de les honorer.

## Ce qu'on ne teste pas (décisions explicites)

- **Le texte exact de l'aide** : on vérifie la traversée (nom du binaire, section usage, code de sortie), pas la mise en forme — elle appartient au parseur (citty).
- **Les dépendances elles-mêmes** (citty) : on teste le comportement d'agentsdir, pas leurs internes.
- **macOS en CI** : ubuntu couvre le mode symlink, windows couvre le mode copie (repli) ; macOS n'apporterait aucun cas supplémentaire.
- **Aucun seuil de couverture bloquant** : la mesure de livraison est la satisfaction des critères d'acceptation des tâches, pas un pourcentage. La couverture est mesurée et lisible (`npm run test:coverage`), elle ne fait échouer personne.
- **L'interactivité `@clack/prompts`** : les tests passent par les drapeaux, par `--yes` ou par le repli non-TTY (défauts) ; le rendu et la navigation des questions appartiennent à la bibliothèque.
- **Quatre règles de `check` restent sans test qui les nomme** : `agent-unreadable`, `lock-skill-missing`, `projection-missing` et `projection-header-removed`. Aucun test ne déclenche ces quatre-là en vérifiant leur message ; c'est un trou connu, pas une décision.
- **Deux `readdir` nus dans `src/`** : `src/core/fs-utils.ts` héberge le helper lui-même et l'unique parcours récursif ; `src/core/projections.ts` en garde un dans `removeIfNoFilesLeft`, où la tolérance est le contrat (nettoyer les sous-dossiers vidés d'un miroir est du meilleur effort, jamais une décision). Toute autre occurrence est refusée par le test-garde de `src/core/__tests__/unreadable-directory.test.ts` : un répertoire illisible lu comme vide a déjà fait passer `check` au vert sur un dépôt qu'il ne voyait pas.
- **Le `padEnd(7)` de `renderGeneratorReport` (`src/commands/add-common.ts`)** : les trois actions d'un générateur — `created`, `updated`, `removed` — font exactement sept caractères, donc le remplissage ne remplit jamais rien. Le retirer ne peut faire échouer aucun test, et la mutation le prouve. Il reste parce qu'il est la défense d'une quatrième action plus courte, pas parce qu'il est observable aujourd'hui ; à ne pas confondre avec l'`actionLabel` de `sync.ts`, où `ok` fait deux lettres et où le remplissage est bel et bien testé.
- **Le doublon de garde de `planLock` (`src/commands/sync.ts`)** : le filtre `NAME_SPEC` y est une ceinture par-dessus les bretelles de `validateRepo`, qui refuse la clé avant que `sync` ne planifie quoi que ce soit. Le retirer ne peut faire échouer aucun test — la garde observable est celle de `src/core/validate.ts`, et c'est elle que la mutation prouve.
