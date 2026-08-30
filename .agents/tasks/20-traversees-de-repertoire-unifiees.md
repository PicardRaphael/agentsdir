# 20 — Une seule traversée de répertoire

## Problème

Trois implémentations de la même marche récursive coexistent, avec des
signatures et des exclusions différentes :

- `core/projections.ts` — `walkFiles(absDir, relPrefix)` → `{ abs, rel }[]`,
  tri par nom, aucune exclusion, pas de `catch`.
- `commands/pack.ts` — `walkFiles(absDir)` → `string[]` de chemins relatifs,
  tri par nom, `catch { return [] }`.
- `core/validate.ts` — `walkSorted(dir, prefix)`, tri par nom, exclut `.git`
  et `node_modules`.

Elles alimentent des calculs qui doivent rester cohérents : les copies
attendues, l'empreinte d'un dossier de skill, la liste des fichiers d'un pack.
Le tri et les exclusions font partie du contrat de déterminisme
(`.agents/rules/code-conventions.md`) ; trois copies, c'est trois endroits où ce
contrat peut diverger sans que rien ne le signale.

## Fichiers

- `src/core/projections.ts` — `walkFiles(absDir, relPrefix)`.
- `src/commands/pack.ts` — `walkFiles(absDir)`.
- `src/core/validate.ts` — `walkSorted(dir, prefix)` et ses exclusions.
- `src/core/fs-utils.ts` — destination de la fonction unique.

## Notes d'implémentation

Le tri se fait en unités de code (`a < b`), jamais par locale : c'est ce qui
rend les empreintes reproductibles d'une machine à l'autre. Vérifier ce point
en priorité, il est plus facile à casser qu'à détecter.

## Critères d'acceptation

- Une seule fonction de traversée, dans `core/fs-utils.ts`, paramétrée par ses
  exclusions et retournant une forme unique (`{ abs, rel }[]`), triée par nom
  en unités de code — le tri actuel, pas un tri par locale.
- Les trois appelants l'utilisent ; leurs exclusions respectives sont passées en
  argument, pas réintroduites en dur.
- L'empreinte d'un dossier de skill est **identique** avant et après : les
  entrées de `skills-lock.json` de ce repo ne bougent pas d'un octet.
- Le déterminisme est prouvé, pas supposé : `node dist/cli.js sync` répond
  « 0 created, 0 updated » sur ce repo après le refactor.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js sync   # attendu : 0 created, 0 updated
git diff --stat skills-lock.json   # attendu : aucun changement
```

## Observation chiffrée, pour éviter une optimisation inutile

`expectedCopies` est recalculé plusieurs fois par exécution : une fois par
`verify` (dans la validation), une fois par le retrait des orphelins, une fois
par la projection. La redondance est réelle mais son coût ne l'est pas : sur un
repo de démonstration à 60 skills et 184 fichiers projetés, `check` prend 352 ms
et `sync` 615 ms. Mutualiser ces passes derrière un cache ajouterait un risque
de péremption pour un gain invisible. À ne reconsidérer que si une mesure sur un
repo réel montre un problème.

## Hors périmètre

Les performances de la traversée sur un très gros repo : à mesurer avant
d'optimiser, et seulement si un cas réel le demande.
