# 35 — Le contrat de la CLI, tenu jusqu'au bout

## Problème

`docs/commandes.md` pose des conventions **transverses**, annoncées comme
s'appliquant à toutes les commandes. Cinq ne sont pas tenues. Chacune a été
reproduite pendant l'audit du 30 août 2026 et vérifiée contradictoirement.

Elles comptent doublement depuis que la direction produit vise à faire de
l'`init` la référence : ce sont exactement les aspérités que rencontre
quelqu'un — ou un agent — qui installe pour la première fois.

### 1. `init` n'accepte pas `--json`

`docs/commandes.md:77` pose la convention (« Every command accepts `--json` and
then writes a single object »), la table d'options d'`init` la reprend (`:103`),
la section Outputs aussi (`:179`). Les neuf autres commandes la déclarent.
`init` non : le drapeau est avalé en silence, la sortie reste le rapport humain,
et `init --help` ne le liste pas.

C'est la commande la plus concernée : c'est celle qu'un agent lance en premier,
et la seule dont il ne peut pas lire le résultat.

### 2. Le bloc géré de permissions n'est jamais écrit — promis quatre fois

`docs/commandes.md:138` (init projette « `.claude/settings.json` (managed
permissions block covering the emitted scripts) »), `:399` (étape 4 de `sync`),
`docs/harness.md:56` et `docs/architecture.md:234` le promettent. Deux blocs
gérés seulement existent dans le code : `ignore` et `rules-index`.

Reproduit : `init` ne crée aucun `.claude/settings.json` ; `pack add
verification` pose un script que le `SKILL.md` fait lancer par `node`, sans
aucune permission — l'invite en cascade que `architecture.md:234` dit
précisément prévenir. Seul `add hook` crée le fichier, avec la seule clé
`hooks`.

### 3. Les questions d'interview des générateurs n'ont pas de drapeau

`docs/commandes.md:45` pose la convention pour toutes les commandes : « Every
interview question has a flag. […] Without a TTY the CLI falls back to the
defaults, so a flag is the only way to give a real answer rather than a guessed
one. » `init` la respecte ; les générateurs non. `add skill` pose six questions
(description, display-name, short-description, color, icon, default-prompt) dont
aucune n'a de drapeau : hors TTY — le chemin agent que le README met en avant —
elles tombent toutes sur des valeurs par défaut.

### 4. L'interview tourne avant les garde-fous

`collectSkillAnswers` pose ses six questions **avant** `runAddSkill`, qui porte
le contrôle d'unicité et la lecture du manifeste. Un utilisateur qui retape un
nom déjà pris, ou qui lance `add skill` avant `init`, répond à tout avant
d'apprendre que rien ne sera écrit.

### 5. Un argument obligatoire manquant sort 1 au lieu de 2

Les six commandes à positionnel requis laissent citty traiter l'absence : il
imprime l'aide et sort **1**. Or `docs/commandes.md` fixe `1` = dérive ou
invariant violé et `2` = erreur d'usage, précisément pour qu'un script de CI
distingue « le dépôt a dérivé » de « tu t'es trompé de commande ».

### 6. La détection de stack invente des commandes

`detectStack` ne teste que la présence du fichier marqueur ; les commandes
écrites dans `AGENTS.md` sont codées en dur et jamais confrontées au contenu de
`package.json`. Avec `--yes` ou sans TTY, elles atterrissent dans `AGENTS.md`
sous forme d'affirmations — un fichier dont le rôle est précisément de dire la
vérité aux agents sur ce dépôt.

## Fichiers

- `src/commands/init.ts` — les args d'`initCommand`, la sortie, la conservation
  du `.gitattributes`.
- `src/commands/add-skill.ts`, `add-rule.ts`, `add-agent.ts`, `add-hook.ts` —
  les drapeaux manquants et l'ordre interview/garde-fous.
- `src/cli.ts` — la traduction de l'erreur d'usage de citty en sortie 2.
- `src/core/detect.ts` — `detectStack` et ses commandes en dur.
- `src/core/managed-blocks.ts` — le mécanisme de bloc géré, à appliquer au JSON.
- `docs/commandes.md`, `docs/harness.md`, `docs/architecture.md` — les
  promesses, à tenir ou à retirer.

## Critères d'acceptation

- `init --json` écrit un objet unique sur stdout, au même format que les autres
  commandes, et `init --help` le liste.
- Le bloc de permissions de `.claude/settings.json` est écrit et maintenu par
  `sync`, couvrant les scripts émis — **ou** les quatre documents qui le
  promettent sont corrigés. Les deux ne peuvent pas rester en désaccord.
- Chaque question d'interview des générateurs a un drapeau, et
  `<commande> --help` les liste tous.
- Nom déjà pris, manifeste absent : le refus arrive **avant** la première
  question.
- Un positionnel obligatoire manquant sort 2, pas 1, sur les six commandes.
- Aucune commande n'est écrite dans `AGENTS.md` sans avoir été trouvée dans le
  dépôt ; à défaut, la ligne est marquée comme à compléter, jamais affirmée.
- Chaque point a un test qui échoue quand le correctif est retiré.

## Notes d'implémentation

**Le point 2 demande une décision, pas seulement du code.** Écrire des
permissions dans le fichier d'un utilisateur est intrusif : le bloc doit être
géré et clairement délimité, comme celui de `.gitignore`, et ne jamais toucher
ce qui l'entoure. Si cette intrusion n'est pas souhaitée, retirer la promesse
des quatre documents est la bonne réponse — mais il en faut une.

**Le point 6 est le plus important pour la direction produit.** Un `AGENTS.md`
qui affirme `npm test` dans un dépôt qui n'a pas ce script est pire qu'un
`AGENTS.md` vide : l'agent le croit. C'est le même critère que le méta-skill
`$setup-context` applique déjà — distinguer ce qui est lu de ce qui est supposé.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js check
```

Puis, sur des dépôts de démonstration : `init --json` sur un dépôt neuf et
vérifier que stdout est un objet unique ; `add skill` avec tous les drapeaux
hors TTY et vérifier qu'aucune valeur par défaut ne subsiste ; `add skill` avec
un nom déjà pris et vérifier qu'aucune question n'est posée ; `add skill` sans
nom et vérifier la sortie 2 ; `init --yes` sur un dépôt Python sans scripts et
vérifier qu'`AGENTS.md` n'invente aucune commande.

## Hors périmètre

Les angles morts de `check` (tâche [33](33-angles-morts-de-check.md)) et le
moteur de projection (tâche [34](34-moteur-de-projection.md)).
