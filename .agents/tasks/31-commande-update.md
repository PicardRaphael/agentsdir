# 31 — La commande `update`, promise partout et absente

## Problème

`update` est spécifiée dans [`docs/commandes.md`](../../docs/commandes.md),
actée comme décision dans [`docs/SPEC.md`](../../docs/SPEC.md), et référencée par
[`docs/conventions.md`](../../docs/conventions.md) et
[`docs/creation-assistee.md`](../../docs/creation-assistee.md). Elle n'existe
pas, et **aucune tâche ne la portait** : la 18 l'exclut explicitement de son
périmètre, la 29 la cite comme « déjà prévue » sans la traiter.

Conséquence structurelle : toute la mécanique `sourceType: "agentsdir"` du
verrou `skills-lock.json` n'a **aucun consommateur**. Le verrou distingue le
contenu installé par la CLI du contenu vendorisé, précisément pour qu'`update`
puisse remplacer le premier sans toucher au second — et rien ne vient jamais
lire cette distinction. On a construit la serrure sans la clé.

Le défaut est visible par l'utilisateur, et c'est ce qui le rend urgent :
`src/core/validate.ts:480` annonce, sans réserve et au futur, que
« `agentsdir update` will propose a merge ». Un utilisateur de la 1.0 qui modifie
un méta-skill localement lit cette phrase, cherche la commande, et ne la trouve
pas. (`src/commands/doctor.ts:132` prend déjà la précaution inverse en écrivant
« when available » : la formulation à retenir.)

## Deux temps à ne pas confondre

**1. Le correctif de message, avant publication.** Une ligne : `validate.ts:480`
doit cesser de promettre un comportement inexistant. C'est une correction de
cohérence, pas une fonctionnalité, et elle ne peut pas attendre la v1.x — elle
part avec la v1.0.

**2. La commande elle-même, en v1.x.** C'est le corps de cette tâche.

## Fichiers

- `src/core/validate.ts:480` — le message à corriger (temps 1).
- `src/commands/update.ts` — à créer.
- `src/cli.ts` — l'enregistrement de la commande et son aide.
- `src/core/manifest.ts` — `MANIFEST_SCHEMA` et la version de schéma, socle des
  transformations.
- `src/packs/index.ts` — les entrées `sourceType: "agentsdir"` du verrou, enfin
  consommées.
- `src/core/projections.ts` — `refreshProjections`, le `sync` final.
- `docs/commandes.md` — la spécification abrégée à compléter et à dater.
- `docs/conventions.md` — le contrat du verrou, à mettre en accord.

## Critères d'acceptation

- `agentsdir update` migre la structure quand le schéma du manifeste a évolué :
  les transformations déclarées d'une version de schéma à la suivante
  s'appliquent aux **blocs gérés et aux projections** uniquement.
- Le contenu écrit par l'utilisateur — `SKILL.md`, règles, corps d'`AGENTS.md` —
  n'est jamais réécrit, ce qui est vérifié par un test sur un dépôt dont chaque
  fichier utilisateur porte une empreinte relevée avant et après.
- Le contenu installé par la CLI et resté intact (`sourceType: "agentsdir"`,
  empreinte conforme) est remplacé par sa nouvelle version.
- Le contenu installé par la CLI mais **modifié localement** est préservé,
  signalé avec le diff amont, et une fusion est proposée — jamais d'écrasement
  silencieux.
- `--dry-run` énonce exactement ce qui serait fait, sans rien écrire.
- La commande se termine par un `sync` complet, et le déterminisme est préservé.
- Codes de sortie conformes à `docs/commandes.md` : `0` à jour, `1`
  transformation impossible sans décision humaine, `2` environnement.
- `--json` est accepté, comme pour toute autre commande.
- Une migration de schéma au moins est réellement déclarée et testée, y compris
  le cas d'un dépôt déjà à jour (aucune écriture, sortie `0`).
- `doctor` cesse d'écrire « when available » une fois la commande livrée.

## Notes d'implémentation

**La transformation est de la donnée, pas du code.** Une table de
transformations d'un schéma au suivant se teste et s'audite ; une cascade de
`if` sur les versions ne se teste pas. Le registre des packs (`PACK_REGISTRY`) a
déjà établi ce motif dans ce dépôt.

**Aucune écriture avant que le plan complet soit calculé.** Une migration
interrompue à mi-course laisse un dépôt dans un état qu'aucune commande ne sait
décrire. Calculer l'intégralité du plan, le présenter, puis écrire — en
réutilisant les écritures atomiques de la tâche
[21](21-ecritures-atomiques.md) si elle est livrée.

**Ne pas confondre avec `migrate`.** `update` fait évoluer une installation
`agentsdir` existante d'un schéma au suivant. `migrate` (v2) importe une
configuration venue d'ailleurs. Les deux sont désormais distinguées dans
`docs/commandes.md` ; ne pas les rapprocher.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js update --dry-run && node dist/cli.js check
```

Puis, sur un dépôt de démonstration installé avec un manifeste de schéma
antérieur : lancer `update --dry-run` et vérifier le plan annoncé, lancer
`update`, vérifier qu'un méta-skill intact a été remplacé, qu'un méta-skill
modifié localement a survécu avec son diff signalé, qu'aucun fichier utilisateur
n'a bougé, et que `check` est vert ensuite.

## Hors périmètre

- `migrate` (v2) et `vendor` (v1.x), traités comme du rattrapage concurrentiel
  et non comme de la différenciation : voir
  [`docs/positionnement.md`](../../docs/positionnement.md).
- Migrer une configuration produite par un autre outil.
