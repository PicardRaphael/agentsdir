# 34 — Le moteur de projection sur ses cas limites

## Problème

Quatre défauts du moteur, reproduits sur dépôts jetables pendant l'audit du
30 août 2026 et vérifiés contradictoirement. Ils ont en commun de ne se
manifester qu'en dehors du chemin nominal — bascule de mode, retrait d'un
harness, gros dépôt, Windows — c'est-à-dire précisément là où ce produit promet
de faire la différence.

### 1. La bascule copie → symlink peut laisser un dépôt irrécupérable — bloquant

`unproject()` supprime d'abord les copies, puis `rmdirIfEmpty` ne fait qu'un
`readdir` **non récursif** sur `.claude/{rules,skills,agents}`. Or une skill
projetée a des sous-dossiers (`agents/`, `assets/`) qui restent vides :
`.claude/skills` survit comme vrai répertoire. `projectSymlinks` le classe
alors « foreign » et lève.

À cet instant, les copies sont déjà détruites, `CLAUDE.md` et `.claude/rules`
sont devenus des liens, et le manifeste n'a jamais été réécrit — il annonce
toujours `mode = "copy"`. Le dépôt est dans un état qu'aucune commande ne sait
décrire ni réparer.

Le précédent existe dans le dépôt : `src/commands/pack.ts` (`removeIfNoFilesLeft`)
parcourt récursivement et supprime le dossier dès qu'il ne reste aucun fichier.

### 2. `--dry-run` annonce un plan qui réussit alors que le vrai échoue

Sur une bascule de mode, `refreshProjections` passe `assumeAbsent: true` au
dry-run. `project()` court-circuite alors la classification et renvoie
« absent » pour toutes les cibles : **aucune cible étrangère ne peut être
signalée**. Le préflight que `sync` promet — le plan complet calculé avant la
moindre écriture — ment exactement dans le cas où il servirait.

### 3. Retirer un harness ne retire rien

`docs/commandes.md:124` promet que « removal follows the same path (orphan
projections are reported by `check` and removed by `sync`) », et `:404` détaille
l'étape 6 de `sync`. **Aucune des deux moitiés n'existe** : `sync.ts` teste
`if (claudeEnabled)` sans `else`, et `validateRepo` saute la vérification des
projections.

Reproduit : après retrait de `claude` de `[harness] enabled` — la procédure que
la documentation prescrit elle-même — `check` sort 0 « no drift », `sync` sort 0
« 0 removed », `CLAUDE.md`, la trentaine de copies et l'enregistrement du hook
restent en place. Une ligne ajoutée ensuite à une règle n'atteint plus sa
projection : elle est figée, et `check` reste vert. Aggravant : ce `sync` vide
`[projections.hashes]` du manifeste **en laissant les fichiers**.

### 4. CRLF : un dépôt avec un `.gitattributes` reste en dérive permanente

`toExpectedCopy` préfixe un en-tête en LF aux octets bruts de la source, et
`init` conserve un `.gitattributes` déjà présent sans avertissement. Un dépôt
portant `* text=auto` sans `eol=lf` ressort d'un checkout Windows entièrement en
CRLF : l'attendu et le disque ne peuvent plus coïncider, et `check` reste rouge
quoi que fasse l'utilisateur.

## Fichiers

- `src/core/projections.ts` — `unproject`, `removeOrphanProjections`,
  `rmdirIfEmpty`, `project` et son `assumeAbsent`, `toExpectedCopy`.
- `src/commands/pack.ts` — `removeIfNoFilesLeft`, le balayage récursif à
  réutiliser.
- `src/commands/sync.ts` — le `if (claudeEnabled)` sans `else`.
- `src/core/validate.ts` — la vérification des projections, sautée quand le
  harness est désactivé.
- `src/commands/init.ts` — la conservation de `.gitattributes`.

## Critères d'acceptation

- La bascule de mode ne peut pas laisser un dépôt à mi-chemin : soit elle
  aboutit, soit elle échoue **avant** la première suppression, en le disant.
- Les répertoires de projection vidés sont supprimés récursivement, en
  réutilisant le balayage existant plutôt qu'en le réécrivant.
- `--dry-run` classe le disque réel, en retranchant les chemins que `unproject`
  retourne : une cible étrangère est signalée à sec comme elle le serait à
  l'exécution.
- Retirer un harness de `[harness] enabled` fait signaler ses projections comme
  orphelines par `check` et les fait supprimer par `sync`, conformément à
  `docs/commandes.md` — ou la documentation est corrigée si la capacité est
  abandonnée, mais les deux cessent de diverger.
- `sync` ne vide jamais `[projections.hashes]` en laissant les fichiers.
- Un dépôt portant un `.gitattributes` sans `eol=lf` est traité explicitement :
  bloc géré ajouté, ou avertissement nommant la ligne à écrire — jamais une
  dérive silencieuse et permanente.
- Chaque cas a un test de non-régression validé par mutation.

## Notes d'implémentation

**L'ordre des opérations est le cœur du point 1.** Calculer entièrement le plan,
y compris la classification des cibles de la mode d'arrivée, **avant** de
supprimer quoi que ce soit. C'est ce que `sync` promet déjà par écrit.

**Le point 3 demande une décision** : implémenter la désactivation d'un harness,
ou la retirer de la documentation. La première est cohérente avec le produit ;
la seconde est honnête si personne ne l'utilise. Ne pas laisser l'écart.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js sync && node dist/cli.js check
```

Puis, sur des dépôts de démonstration : basculer copy → symlink avec une skill
projetée et vérifier qu'aucun état intermédiaire ne subsiste ; retirer un
harness et vérifier que `check` signale puis que `sync` supprime ; initialiser
un dépôt portant `* text=auto` et vérifier que `check` ne reste pas rouge sans
issue.

## Hors périmètre

Les angles morts de la vérification elle-même : tâche
[33](33-angles-morts-de-check.md).
