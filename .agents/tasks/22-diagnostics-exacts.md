# 22 — Diagnostics exacts quand un fichier est illisible

## Problème

Plusieurs messages affirment une cause qu'ils n'ont pas vérifiée. Le motif est
toujours le même : un `catch` traite l'échec de lecture comme une absence, et le
message décrit l'absence.

- `src/core/validate.ts` — un `SKILL.md` illisible produit « skill folder has no
  SKILL.md — write it or delete the folder ». Le fichier est là ; le conseil est
  faux et envoie l'utilisateur dans la mauvaise direction.
- `src/core/projections.ts` — une projection illisible produit « projection
  missing — run `agentsdir sync` », puis `sync` échoue à la recréer.
- `src/core/hook-registries.ts` — une métadonnée `agentsdir:hook` en JSON
  invalide fait ignorer le hook en silence : aucun message, le hook n'est
  simplement jamais enregistré.
- `src/commands/doctor.ts` — un manifeste illisible fait sortir `doctor` en 2,
  alors que sa promesse affichée est « diagnosis only; exit 0 even with
  problems ». Un problème diagnostiquable devrait devenir un *finding*, pas un
  échec de la commande.

Les cas où l'erreur avalée *détruisait* du contenu ont été corrigés (voir le
CHANGELOG 1.0.0). Restent ceux qui ne détruisent rien mais trompent le lecteur.

## Fichiers

- `src/core/validate.ts` — `validateSkill`.
- `src/core/projections.ts` — `verifyCopies`, `verifySymlinks`, `ownedCopies`.
- `src/core/hook-registries.ts` — la lecture des métadonnées de script.
- `src/commands/doctor.ts` — la lecture du manifeste.

## Notes d'implémentation

Le remède est partout le même : inspecter le code errno. `ENOENT` garde le
message d'absence ; tout autre code dit ce qui s'est réellement passé et sur
quel chemin. `asUserFacingError` (`src/core/errors.ts`) donne déjà la forme du
message et le code de sortie attendu.

## Critères d'acceptation

- Aucun message n'affirme qu'un fichier est absent sans l'avoir vérifié.
- `doctor` diagnostique un manifeste illisible au lieu d'échouer, conformément à
  sa promesse d'exit 0.
- Une métadonnée de hook invalide produit un message nommant le fichier, au lieu
  d'un silence.
- Un test couvre au moins un cas par fichier touché.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js check
```

## Hors périmètre

La reprise automatique après une erreur de lecture : signaler correctement
suffit. Réparer à la place de l'utilisateur, sur un fichier qu'on n'a pas pu
lire, serait exactement la faute que cette famille de bugs a produite.
