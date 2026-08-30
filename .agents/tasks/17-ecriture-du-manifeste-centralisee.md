# 17 — Une seule porte d'écriture du manifeste

## Problème

`core/manifest.ts` expose `writeManifest`, présenté dans `docs/architecture.md`
comme « le seul module autorisé à écrire le manifeste ». Le code ne tient pas
cette promesse : quatre chemins d'écriture coexistent et trois court-circuitent
`writeManifest` en appelant `renderManifest` puis en écrivant eux-mêmes.

- `commands/add-common.ts` → `writeManifest` (le seul conforme)
- `commands/init.ts` → `renderManifest` dans un `PlannedWrite`, écrit par `applyPlan`
- `commands/pack.ts` → `renderManifest` + `writeFile`, deux fois (`runPackAdd`, `runPackRemove`)
- `commands/sync.ts` → `renderManifest` dans un `PlannedFile`, écrit par `applyPlannedFile`

Conséquence concrète : toute règle qui devrait valoir pour *chaque* écriture du
manifeste — mettre à jour `cliVersion`, journaliser une migration de schéma,
refuser un manifeste incohérent — doit être répétée quatre fois, et une omission
ne se voit pas. C'est le même genre d'écart doc/code que la tâche 14 a corrigé
ailleurs.

La difficulté réelle : `init` et `sync` n'écrivent pas directement, ils
*planifient* (pour `--dry-run`), puis appliquent. Une centralisation naïve
casserait le contrat « le plan est calculé avant toute écriture ».

## Fichiers

- `src/core/manifest.ts` — `writeManifest`, `renderManifest` : la porte à faire respecter.
- `src/commands/init.ts` — `runInit` compose le manifeste, `applyPlan` l'écrit.
- `src/commands/sync.ts` — `planManifest`, appliqué par `applyPlannedFile`.
- `src/commands/pack.ts` — `runPackAdd` et `runPackRemove`, deux `writeFile` directs.
- `src/commands/add-common.ts` — `resyncProjections`, seul appelant conforme.
- `docs/architecture.md` — le tableau des modules, à remettre en accord.

## Notes d'implémentation

Le point délicat est le `--dry-run` : `init` et `sync` planifient avant
d'écrire. Une piste est de laisser `core/manifest.ts` exposer le rendu *et*
l'écriture, et de faire porter aux commandes un plan qui référence cette
écriture au lieu de la refaire. Ne pas casser l'ordre d'écriture de `sync`
(manifeste en dernier).

## Critères d'acceptation

- Un seul point de rendu-puis-écriture du manifeste, dans `core/manifest.ts`.
- `--dry-run` reste exact pour `init`, `sync` et `pack` : le plan annoncé est
  identique aux écritures réelles, manifeste compris.
- `sync` continue d'écrire le manifeste **en dernier**, ses empreintes décrivant
  l'état final (invariant actuel, à ne pas perdre).
- La sortie octet-à-octet du manifeste est inchangée : sur ce repo,
  `node dist/cli.js sync` répond « 0 created, 0 updated » après le refactor.
- `docs/architecture.md` décrit le chemin réel ; la ligne « le seul module
  autorisé à écrire le manifeste » devient vraie.
- Un test échoue si un module hors `core/manifest.ts` écrit `.agents.toml`
  (même forme que `src/__tests__/layering.test.ts`).

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js sync   # attendu : 0 created, 0 updated
node dist/cli.js check  # attendu : exit 0
```

## Hors périmètre

Le format du manifeste, sa version de schéma, les migrations `update` (v1.x).
