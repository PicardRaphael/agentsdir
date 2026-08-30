# 26 — Valider par un agent réel ce que les tests ne peuvent pas voir

## Problème

Les tests de bout en bout (`e2e/journeys.test.ts`) prouvent que les bons octets
arrivent aux bons endroits : `init --yes` → `add skill` → `check` sur des dépôts
TypeScript et Python, dans les deux modes de projection, sur ubuntu et windows.
C'est solide et ça tourne à chaque commit.

Ils ne prouvent pas la promesse du produit. `docs/roadmap.md` énonce comme
critère de sortie de la v0.3 : « un skill créé par `add skill` est **découvert
par Claude Code** (`/nom`) et **affiché par Codex** avec son icône et sa
couleur, sans aucune édition manuelle ». **Ce critère n'a jamais été vérifié.**
Un `check` vert dit que le fichier est conforme au rendu attendu ; il ne dit pas
qu'un harness le lit, l'affiche, ou déclenche le hook enregistré.

L'écart est exactement celui entre « le fichier est correct » et « le fichier
sert ». Personne ne peut le combler avec un test automatisé classique : il faut
un agent réel, dans une vraie session, sur un dépôt fraîchement installé.

## Fichiers

- `docs/roadmap.md` — le critère v0.3, à valider ou à corriger.
- `docs/harness.md` — la matrice d'intégration, dont c'est la vérification.
- `e2e/journeys.test.ts` — ce qui est déjà couvert, à ne pas refaire.
- `.agents/tasks/26-validation-par-un-agent-reel.md` — ce fichier, à supprimer
  à la livraison.

## Notes d'implémentation

**Ne pas refaire les e2e.** Faire rejouer `init`, `add skill` et `check` par un
agent n'apporte rien : c'est déjà testé, en CI, sur deux systèmes. La valeur est
ailleurs, dans ce qu'un test ne peut pas observer.

**Ce que l'agent doit vérifier, lui.** Sur un dépôt neuf où `agentsdir init` et
`add skill` viennent de tourner :

- le skill créé apparaît-il dans la liste des skills du harness, et
  l'invocation par son nom fonctionne-t-elle ;
- le sous-agent créé par `add agent` est-il proposé à la délégation ;
- un hook créé par `add hook PreToolUse` se déclenche-t-il réellement lors d'un
  appel d'outil, et son `exit 2` bloque-t-il l'action ;
- `AGENTS.md` et l'index des règles sont-ils effectivement lus — l'agent
  connaît-il, sans qu'on les lui redonne, les commandes de test du dépôt ;
- les messages de la CLI suffisent-ils à savoir quoi faire ensuite, sans lire la
  documentation.

**La forme du livrable est un prompt versionné**, pas une procédure orale : un
scénario reproductible que n'importe qui peut redonner à un agent après une
release, avec une grille d'observation et un compte rendu attendu. Le placer là
où la stratégie de test est décrite (`TESTING.md`), comme troisième tier après
l'unitaire et l'e2e — un tier manuel, assumé comme tel.

**Deux terrains, complémentaires.** Un dépôt neuf donne la reproductibilité ; un
dépôt réel déjà pourvu de `.agents/` et de skills (par exemple `nowstack-saas`)
donne le cas que personne n'a testé : que se passe-t-il quand `init` rencontre
une configuration préexistante ? C'est aussi la répétition générale de `migrate`
(v2). Faire les deux, dans cet ordre.

**Ce qui est hors de portée d'un agent seul** : l'affichage de l'icône et de la
couleur dans Codex est visuel. Le noter comme tel plutôt que de le déclarer
validé.

## Critères d'acceptation

- Un prompt de validation versionné, reproductible, exécutable après chaque
  release, énonçant ce qui est observé et comment le consigner.
- La validation est jouée au moins une fois sur Claude Code, et le compte rendu
  est conservé dans le dépôt.
- Chaque point du critère v0.3 de `docs/roadmap.md` reçoit un verdict :
  vérifié, infirmé, ou hors de portée d'une validation par agent.
- Tout écart constaté devient une tâche ou un correctif — la validation n'a pas
  de valeur si son résultat ne change rien.
- `TESTING.md` décrit ce tier manuel, sa raison d'être et sa fréquence.
- Si le critère v0.3 se révèle faux sur un point, `docs/roadmap.md` est corrigé :
  un critère de sortie non tenu ne reste pas écrit comme acquis.

## Vérification

```bash
npm run build && npm run test:e2e   # l'automatisable reste automatisé
node dist/cli.js check
```

Puis la validation elle-même : dérouler le prompt sur un dépôt neuf, consigner
le compte rendu, et ouvrir une tâche par écart constaté.

## Hors périmètre

Automatiser la conduite d'un agent réel dans la CI : coûteux, fragile, et
dépendant de services tiers. Ce tier reste manuel et peu fréquent — après une
release, ou après un changement touchant les projections ou les hooks.
