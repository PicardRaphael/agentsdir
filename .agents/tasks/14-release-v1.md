# 14 — Release v1.0

Dépend de : 10, 11, 12, 13, 15, 16

## Problème

Passer d'un outil qui marche chez nous à un outil publiable : documentation publique en anglais, preuves de bout en bout, publication npm.

## Fichiers

- `README.md` (réécrit en anglais, la version française archivée dans `docs/`), documentation publique `docs/` en anglais
- `e2e/` : tests de bout en bout sur repos de démonstration
- `package.json` (métadonnées npm complètes : description, keywords, repository, license MIT)

## Critères d'acceptation

- Tests de bout en bout : `init --yes` puis `add skill` puis `check` sur un repo TypeScript de démonstration ET un repo Python de démonstration ; les deux modes couverts (symlink sur le runner ubuntu, copie sur le runner windows sans privilèges).
- Autophagie complète : ce repo est géré par sa propre CLI (`init` exécuté, `check` dans sa CI, le pont `CLAUDE.md` généré par le moteur de projections).
- Interopérabilité vérifiée : un skill installé par `npx skills` (Vercel) dans `.agents/skills/` n'est pas cassé par `sync` ni signalé à tort par `check`.
- Création assistée prouvée de bout en bout : `$setup-context` puis `$create-skill` déroulés sur les repos de démonstration, artefacts produits verts à `check`.
- Messages de la CLI relus (anglais), `--help` complet par commande.
- `npm publish` en 1.0.0 (accès public), tag git, notes de release.
- Annonce préparée (billet court : le problème, la démo en 5 commandes, le lien) — publication décidée par l'utilisateur.

## Vérification

```bash
npm run test:e2e
npx agentsdir@latest init --dry-run   # depuis un dossier vierge, après publication
```

## Hors périmètre

`vendor`, `update`, pack `logs` (v1.x) ; `migrate` (v2) ; site web.
