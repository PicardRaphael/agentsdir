# 03 — Manifeste `.agents.toml`

Dépend de : 01

## Problème

La CLI a besoin d'un état persistant dans le repo cible : version du schéma, harness activés, packs installés, mode de projection, empreintes des copies.

## Fichiers

- `src/core/manifest.ts` + tests
- Schéma documenté dans `docs/architecture.md` (section « Le manifeste ») — le code doit s'y conformer ; si le schéma doit évoluer, la doc évolue dans le même commit.

## Critères d'acceptation

- Lecture/écriture de `.agents.toml` (via `smol-toml`), avec champ `schema` (entier, versionné) permettant les migrations futures (`update`, v1.x).
- Champs : `schema`, `cli-version`, `[project]` (`name`, `stack`), `[harness] enabled` (liste), `[packs] installed` (liste), `[projections] mode` (`"symlink"` | `"copy"`), `[projections.hashes]` (en mode copie : chemin → empreinte sha256 du contenu généré).
- Écriture déterministe : deux écritures du même état produisent le même fichier octet à octet (les empreintes en dépendent).
- Erreurs explicites : manifeste absent, schéma inconnu (trop récent), TOML invalide → exit 2 avec message actionnable.

## Vérification

```bash
npm test -- manifest
```

## Hors périmètre

La logique de migration de schéma (v1.x, commande `update`).
