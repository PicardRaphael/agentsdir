# 21 — Écritures atomiques

## Problème

Aucune écriture de la CLI n'est atomique. `init` applique jusqu'à 90 opérations
mutantes consécutives (8 `mkdir`, 38 créations, 4 liens sur un dépôt vierge),
`sync` 19, `pack add|remove` 9, sans journal ni reprise. Une interruption —
Ctrl+C, coupure de courant, disque plein — laisse le dépôt à mi-chemin.

La plupart de ces états sont réparables par `sync` depuis la correction des
écritures interrompues. Deux ne le sont pas :

- `add hook` écrit le script puis enregistre les trois registres l'un après
  l'autre. Interrompu après le deuxième, il laisse deux harness sur trois
  enregistrés, sort en 1 — et `check` répond « Check passed ». L'incohérence
  est invisible en CI.
- `pack remove` interrompu retire le dossier d'un skill avant de mettre le
  verrou à jour : `lock-skill-missing` n'est pas dans les règles réparables,
  donc ni `check` ni `sync` ne rattrapent l'état.

Le projet connaît pourtant le motif : il l'écrit dans les scripts qu'il génère
(`src/packs/worktrees.ts`, « atomic write: the durable context lands in a single
rename »). Il l'applique au code produit, pas au code producteur.

## Fichiers

- `src/commands/init.ts` — `applyPlan`.
- `src/commands/sync.ts` — `applyPlannedFile`.
- `src/commands/pack.ts` — `runPackAdd`, `runPackRemove`.
- `src/commands/add-hook.ts` — la séquence des trois registres.
- `src/core/projections.ts` — `projectCopies`, `projectSymlinks`.
- `src/packs/worktrees.ts` — le motif écriture-puis-rename déjà rédigé.

## Notes d'implémentation

Écrire dans un fichier temporaire du même répertoire puis `rename` suffit pour
l'atomicité par fichier, qui est le gain principal et le moins risqué.
L'atomicité de la *séquence* est un autre problème, bien plus coûteux : ne la
traiter que si un cas réel le demande, et en priorité pour `add hook`, le seul
dont l'état intermédiaire est invisible à `check`.

## Critères d'acceptation

- Chaque écriture de fichier est atomique : la cible n'existe jamais dans un
  état partiel, quelle que soit l'interruption.
- `add hook` interrompu ne laisse pas un sous-ensemble de registres enregistrés,
  ou bien `check` le détecte et `sync` le répare.
- Le déterminisme est préservé : `node dist/cli.js sync` répond
  « 0 created, 0 updated » sur ce repo après le refactor.
- Un test simule une interruption entre deux écritures et vérifie que l'état
  résultant est réparable par `sync`.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js sync && node dist/cli.js check
```

## Hors périmètre

Une transaction couvrant toute une commande, avec journal et rollback : le coût
dépasse largement le risque pour une CLI dont la commande la plus longue écrit
90 fichiers dans un dépôt versionné par git.
