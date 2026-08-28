# Conventions de code

À lire avant d'écrire ou modifier tout fichier `src/**`, `e2e/**` ou config d'outillage.

## Règles

- TypeScript strict, ESM (`type: module`), Node >= 20.
- **Dépendances d'exécution limitées** à `citty` (ou `commander`), `@clack/prompts`, `smol-toml`. Toute addition exige une justification écrite dans `docs/architecture.md`, dans le même commit.
- **Messages de la CLI en anglais** (la doc de conception est en français, pas le produit).
- **Codes de sortie centralisés** dans `src/exit-codes.ts` : `0` ok · `1` dérive ou invariant violé · `2` erreur d'environnement ou d'utilisation. Jamais de `process.exit()` avec un littéral ailleurs.
- **Déterminisme octet à octet** pour tout contenu généré (openai.yaml, icônes, manifeste, copies) : deux exécutions du même état produisent les mêmes octets. Les empreintes et `check` en dépendent.
- Fins de ligne `\n` en écriture de fichiers, toujours (le `.gitattributes` force eol=lf).
- Aucun chemin machine codé en dur ; tout repli vient du manifeste ou du nom du projet.

## Interdits

- NEVER : dépendance react/lucide à l'exécution (les icônes sont des tracés SVG vendorés en JSON statique).
- NEVER : écraser un fichier utilisateur. La CLI n'écrit que ses blocs gérés et les fichiers portant son en-tête généré.
- NEVER : recalculer le mode de projection en silence — le mode vit dans `.agents.toml`, sa bascule est une action explicite (`sync --mode`).

## Tests

- Les noms des tests reprennent les critères d'acceptation des tâches, au format Given/When/Then.
- Tests sur répertoires temporaires ; jamais d'écriture dans le repo pendant les tests.
- La CI tourne sur ubuntu ET windows : tout test du mode copie doit passer sans symlinks.
