# 23 — Injection de pannes dans les tests

## Problème

Aucun test de la suite ne simule une écriture qui échoue, un disque plein ou un
fichier illisible. Vérifié par recherche sur `src/**/__tests__` et `e2e/` :
`EACCES`, `ENOSPC`, `EISDIR`, `EPERM`, `chmod`, `mockRejected`, `vi.mock` et
`spyOn` n'apparaissent dans aucune assertion — seulement dans des libellés de
test et une constante de fixture.

C'est ce trou qui a laissé passer les cinq défauts trouvés par l'audit
d'architecture : tous vivaient dans un chemin d'erreur, aucun n'était exercé.
Le pire d'entre eux — un répertoire illisible lu comme vide, qui faisait
supprimer des projections en sortie 0 — aurait été attrapé par un seul test de
panne. Les correctifs sont désormais couverts par des tests dédiés, mais au cas
par cas : rien n'empêche le prochain chemin d'erreur d'échapper de la même
façon.

L'outil de couverture n'est pas installé (`@vitest/coverage-v8` absent), donc
aucun chiffre ne situe l'ampleur du trou.

## Fichiers

- `src/test-support/index.ts` — l'endroit naturel pour des utilitaires de panne.
- `package.json` — `@vitest/coverage-v8` en dépendance de développement.
- `TESTING.md` — la stratégie à compléter.
- `src/core/__tests__/`, `src/commands/__tests__/` — les suites à compléter.

## Notes d'implémentation

Sur Windows, `chmod` ne produit pas d'`EACCES`. Les tests de panne déjà écrits
obtiennent `ENOTDIR`/`EISDIR` en plaçant un fichier là où un répertoire est
attendu — technique portable, et suffisante puisque le code inspecte désormais
le code errno. La préférer à un mock de `node:fs`, qui testerait le mock.

Deux modules concentrent le risque et n'ont aucun fichier de test dédié :
`src/core/validate.ts` et `src/core/hook-registries.ts`, soit environ mille
lignes couvertes seulement de façon indirecte.

## Critères d'acceptation

- Un utilitaire partagé rend un chemin illisible de façon portable, utilisé par
  les tests plutôt que réécrit dans chacun.
- Chaque commande qui écrit a au moins un test où une écriture échoue, vérifiant
  le code de sortie, le message, et l'état du dépôt après l'échec.
- `@vitest/coverage-v8` est installé et une commande de couverture existe ; son
  rapport est lisible en CI.
- Les fichiers les moins couverts sont nommés dans `TESTING.md`, avec la
  décision prise pour chacun : couvrir, ou assumer et dire pourquoi.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run test:coverage
npm run build && npm run test:e2e
```

## Hors périmètre

Un seuil de couverture bloquant en CI : `TESTING.md` a explicitement écarté
cette mesure au profit des critères d'acceptation, et rien dans l'audit ne
justifie de rouvrir la décision.
