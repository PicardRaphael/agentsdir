# 36 — Les garde-fous que rien ne teste

## Problème

Quatre familles de garde-fous existent dans le code, sont documentées, et
ne sont affirmées par aucun test. Une garde non testée est une garde qui
disparaîtra au prochain refactor sans que personne ne le voie — et
l'audit du 30 août 2026 a montré que c'est exactement ce qui s'était produit
pour `ensureNoLinkedParent`, appelée sur un chemin d'écriture sur cinq.

`TESTING.md` décrit la stratégie de test du dépôt ; ces quatre trous en sont
l'écart le plus net.

### 1. Le contrat `--json` en cas d'échec

`docs/commandes.md:77` promet qu'en `--json` chaque commande écrit **un seul
objet** sur stdout, destiné aux scripts et à la CI. La branche qui tient cette
promesse quand la commande lève une `CliError` existe en cinq exemplaires — et
aucun test ne vérifie qu'un échec produit bien un objet JSON plutôt qu'un
message humain sur stdout. C'est pourtant le cas qui compte pour un script :
celui où quelque chose ne va pas.

### 2. `sanitizeHook`, un bug corrigé sans filet

`sanitizeHook` retire `<!--` et `-->` de la première ligne d'une règle avant de
l'injecter dans le bloc géré `rules-index`. Son commentaire décrit le bug
passé : « a line carrying an end marker split the block in two, so every sync
appended another copy and check stayed red for good ». Aucun test n'écrit une
règle dont la première ligne porte un marqueur : la régression rejouerait à
l'identique.

### 3. L'évasion de chemin par la clé du lock

La clé d'une entrée de `skills-lock.json` devient un segment de chemin. Le
commentaire du code le dit : « a lock from a cloned repo could otherwise point
the reader at a directory outside the repository ». Le filtre `NAME_SPEC` existe
en deux exemplaires — et rien ne vérifie qu'un `skills-lock.json` fabriqué avec
une clé `../../evil` est refusé.

C'est la même classe de défaut que les quatre évasions par lien symbolique
corrigées le 30 août : un dépôt cloné est une entrée non fiable.

### 4. Sept règles de `check` ne sont assertées nulle part

`check` est la porte de CI du produit. Sept de ses règles n'ont aucun test :
`skill-frontmatter`, `skill-md-missing`, `skill-md-unreadable`,
`skill-name-spec`, `skill-unknown-icon`, `agents-md-missing`,
`rules-index-missing`.

## Fichiers

- `src/commands/check.ts`, `sync.ts`, `add-common.ts`, `pack.ts` — les cinq
  branches `--json` en cas d'erreur.
- `src/templates/agents-md.ts` — `sanitizeHook`.
- `src/core/validate.ts` — le filtre de la clé du lock et les sept règles.
- `TESTING.md` — la stratégie, à mettre en accord avec ce qui est réellement
  couvert.

## Critères d'acceptation

- Un test par commande vérifie qu'en `--json` **un échec** écrit un objet unique
  et parsable sur stdout, avec `errors` non vide et le bon `exitCode`, et rien
  d'autre sur stdout.
- Une règle dont la première ligne porte `<!--` ou `-->` est écrite, projetée et
  vérifiée : le bloc `rules-index` reste unique, `sync` est idempotent et
  `check` vert.
- Un `skills-lock.json` dont une clé s'évade (`../../evil`, chemin absolu,
  caractère réservé) est refusé, et rien n'est lu ni écrit hors du dépôt.
- Chacune des sept règles de `check` a un test qui la déclenche et vérifie son
  message.
- Chaque test ajouté est validé par mutation : la garde retirée, il échoue.
- `TESTING.md` décrit ce qui est couvert et ce qui ne l'est pas, sans
  approximation.

## Notes d'implémentation

**Le tableau de bord de cette tâche est la mutation.** Un test qui passe aussi
bien avec qu'sans la garde ne prouve rien ; c'est ce qui a permis aux quatre
évasions de survivre à une suite verte. Chaque test ajouté ici doit être
accompagné, dans le message de commit, de la preuve qu'il échoue quand on retire
ce qu'il teste.

**Réutiliser `src/test-support/`** plutôt que de refabriquer des dépôts
temporaires : l'audit d'architecture a consolidé ces fabriques, les ignorer les
ferait diverger à nouveau.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js check
```

Puis, pour chaque garde ajoutée : retirer la garde, vérifier que le test
échoue, la remettre, coller les deux sorties.

## Hors périmètre

Corriger les défauts que ces tests révéleraient : ils deviennent des tâches à
part, ou rejoignent [33](33-angles-morts-de-check.md), [34](34-moteur-de-projection.md)
et [35](35-contrat-de-la-cli.md) selon leur nature.
