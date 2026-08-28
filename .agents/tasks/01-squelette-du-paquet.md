# 01 — Squelette du paquet npm

## Problème

Le projet n'a aucun code. Il faut la fondation : un paquet TypeScript exécutable via `npx agentsdir`, testable, avec sa propre CI.

## Fichiers

- `package.json` (name: `agentsdir`, bin, engines node >= 20, type: module)
- `tsconfig.json` (strict), `src/cli.ts` (point d'entrée), `src/commands/` (vide)
- `vitest.config.ts`, `src/__tests__/smoke.test.ts`
- `.github/workflows/ci.yml` (typecheck, lint, test, build sur ubuntu + windows)
- Outil de bundle : `tsup` (sortie unique `dist/cli.js`)
- Linter/formatter unique et bloquant : ESLint + Prettier, branchés en CI
- `TESTING.md` : tiers de tests retenus, conventions de nommage, comment lancer chaque niveau, et ce qu'on ne teste pas (décision explicite)

## Critères d'acceptation

- `npm run build` produit un bundle unique ; `node dist/cli.js --help` affiche l'aide.
- Dépendances d'exécution limitées à : `citty` (ou `commander`), `@clack/prompts`, `smol-toml`. Rien d'autre sans justification écrite dans `docs/architecture.md`.
- `npx .` fonctionne depuis un dossier quelconque (test manuel).
- CI verte sur ubuntu-latest ET windows-latest (le mode copie sera testé sous Windows : la CI Windows n'est pas optionnelle).
- Au moins un test qui passe avant toute feature : la chaîne de test existe dès le squelette (« walking skeleton » : `node dist/cli.js --help` traverse parseur → sortie).
- Les noms des tests reprennent les critères d'acceptation des tâches, au format Given/When/Then.

## Notes d'implémentation

- Voir `docs/architecture.md`, section « Décisions techniques ».
- Messages de la CLI en anglais dès le départ (la doc de conception est en français, pas le produit).
- Codes de sortie : 0 ok, 1 dérive/invariant, 2 erreur d'environnement ou d'utilisation — centralisés dans `src/exit-codes.ts`.

## Vérification

```bash
npm run build && node dist/cli.js --help
npm test
```

## Hors périmètre

Toute commande réelle (arrive en 04) ; publication npm (tâche 14).
