# 27 — Projeter la configuration des serveurs MCP

## Problème

Un dépôt qui déclare des serveurs MCP doit aujourd'hui le faire trois fois, dans
trois fichiers de formats différents, et les tenir synchronisés à la main :
`.mcp.json` pour Claude Code, `.cursor/mcp.json` pour Cursor,
`.codex/config.toml` pour Codex. C'est exactement le problème que ce produit
résout pour les règles, les skills et les hooks — et c'est le seul des quatre
qu'il ne traite pas.

Ce n'est pas une lacune théorique : c'est l'écart le plus net avec les deux
concurrents directs. [ruler](https://github.com/intellectronica/ruler) et
[rulesync](https://github.com/dyoshikawa/rulesync) propagent tous deux la
configuration MCP ; voir [recherche/paysage-2026-08.md](../../docs/recherche/paysage-2026-08.md).

Structurellement, c'est le jumeau des hooks : une déclaration unique dans
`.agents/`, plusieurs cibles aux formats hétérogènes, une fusion qui doit
préserver ce que l'utilisateur a écrit lui-même, et une dérive à détecter. Le
moteur existe (`core/hook-registries.ts` en est le précédent complet) ; il
s'agit de l'appliquer à un quatrième objet, pas d'en inventer un.

## Fichiers

- `src/core/hook-registries.ts` — le précédent : matrice par harness, fusion
  structurelle, reconnaissance de ce qui nous appartient, déregistration propre.
- `src/core/projections.ts` — le moteur de projection et sa vérification.
- `src/core/validate.ts` — les invariants, à étendre à la nouvelle projection.
- `src/commands/sync.ts` — la régénération.
- `src/commands/add-*.ts` — le modèle d'un générateur, si `add mcp` se justifie.
- `docs/harness.md` — la matrice d'intégration, à compléter et à dater.
- `docs/conventions.md` — le contrat de la nouvelle source.

## Notes d'implémentation

**Établir la matrice avant d'écrire une ligne.** L'erreur à éviter est celle que
`hook-registries.ts` documente pour Cursor : une forme supposée, démentie par la
documentation officielle. Consulter les trois documentations, noter la date de
validation dans le code, et n'implémenter que ce qui est vérifié. Les formats
diffèrent au-delà de la syntaxe : JSON contre TOML, emplacements distincts,
conventions de nommage propres à chaque harness.

**La fusion, pas l'écrasement.** Un `.mcp.json` contient souvent des serveurs
que l'utilisateur a ajoutés à la main, parfois avec des secrets d'environnement.
Les règles de `planHookRegistrations` s'appliquent telles quelles : une entrée
nous appartient si elle correspond exactement à ce que nous générons, tout le
reste est intouchable, et un fichier dont la structure ne change pas garde ses
octets.

**Les secrets ne passent pas par la source de vérité.** Un serveur MCP se
configure souvent avec des jetons. `.agents/` est versionné : la déclaration y
porte le nom des variables d'environnement attendues, jamais leur valeur. Un
test doit vérifier qu'une valeur ressemblant à un secret n'atterrit pas dans un
fichier versionné.

**Rester dans le périmètre.** Ce produit installe et vérifie de la
configuration ; il ne lance pas de serveur, n'en découvre pas sur le réseau et
ne valide pas qu'un serveur répond. `doctor` peut signaler qu'un binaire déclaré
est introuvable sur le PATH — c'est un diagnostic, pas une exécution.

**Surveiller la spécification.** MCP en est à la révision du 28 juillet 2026, et
un groupe de travail « Skills over MCP » pourrait faire converger les deux
objets de ce produit. Décider ici de ce qui est stable et de ce qui attend.

## Critères d'acceptation

- Une source unique dans `.agents/` déclare les serveurs MCP du dépôt.
- `sync` projette cette déclaration vers les harness activés, dans leur format
  réel et vérifié, sans jamais toucher aux serveurs déclarés par l'utilisateur.
- `check` détecte la dérive d'une projection MCP comme il le fait pour les
  autres, avec un message qui nomme le fichier et le correctif.
- Le retrait d'un serveur de la source le retire des projections au `sync`
  suivant (déregistration propre, comme pour les hooks).
- Aucune valeur de secret n'entre dans un fichier versionné — vérifié par test.
- La matrice des trois formats est documentée dans `docs/harness.md`, avec sa
  date de validation et la source consultée pour chaque harness.
- Le déterminisme est préservé : `node dist/cli.js sync` répond
  « 0 created, 0 updated » sur ce repo après le refactor.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js sync && node dist/cli.js check
```

Puis, sur un dépôt de démonstration : déclarer deux serveurs, `sync`, vérifier
les trois fichiers produits contre les documentations officielles ; ajouter un
serveur à la main dans `.mcp.json`, `sync`, vérifier qu'il survit intact ;
retirer un serveur de la source, `sync`, vérifier qu'il disparaît des trois.

## Hors périmètre

Lancer, superviser ou tester un serveur MCP. Découvrir des serveurs depuis un
registre distant. Proposer des serveurs adaptés au dépôt : cela relève de la
tâche 24, une fois cette projection livrée.
