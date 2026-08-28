# 06 — Génération des métadonnées Codex

Dépend de : 03

## Problème

Codex/ChatGPT lit `agents/openai.yaml` et une icône par skill. Personne ne les génère automatiquement aujourd'hui : c'est un différenciateur. La source est le frontmatter étendu de `SKILL.md` — jamais un catalogue codé en dur.

## Fichiers

- `src/core/frontmatter.ts` (parse et valide le frontmatter étendu) + tests
- `src/core/codex-metadata.ts` (rendu `openai.yaml` + icône SVG) + tests
- `src/icons/` : jeu d'icônes embarqué (sous-ensemble des tracés SVG de lucide, vendorés en JSON statique — licence ISC de lucide à créditer)

## Critères d'acceptation

- Champs du frontmatter étendu (voir `docs/conventions.md`) : `display-name`, `short-description` (chaîne explicite, validée entre 25 et 64 caractères), `color` (#RRGGBB), `icon` (nom du jeu embarqué), `default-prompt` (doit contenir `$<name>`), `implicit` (bool).
- Rendu `agents/openai.yaml` conforme au format officiel Codex : blocs `interface:` (display_name, short_description 25–64 caractères, icon_small/icon_large → `./assets/icon.svg`, brand_color, default_prompt) et `policy:` (allow_implicit_invocation).
- Rendu de l'icône : SVG 128×128, tracé blanc trait 1.8 sur `<rect rx="5">` rempli de la couleur, `<title>` et `aria-label` dérivés du nom affiché.
- Rendu déterministe octet à octet (empreintes et `check` en dépendent) ; aucune dépendance react/lucide à l'exécution.
- Erreurs de validation claires : champ manquant, couleur invalide, icône inconnue (avec suggestion), prompt sans `$<name>`.

## Vérification

```bash
npm test -- frontmatter codex-metadata
```

## Hors périmètre

La commande `add skill` (09) ; les invariants globaux (07).
