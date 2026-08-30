# 29 — Aider un dépôt à suivre l'évolution des pratiques

> Périmètre tranché le 30 août 2026 avec l'utilisateur. La voie « veille active
> sur des sources externes » est écartée ; les normes vivent dans la version de
> la CLI. Le raisonnement qui a mené là est conservé dans la section
> « Pourquoi ce périmètre », parce qu'il conditionne les critères.

## Problème

Les pratiques bougent plus vite que les dépôts. Un dépôt configuré il y a six
mois porte une structure qui était une bonne pratique et ne l'est plus, sans que
rien ne le signale.

Le produit sait aujourd'hui vérifier qu'une configuration est **conforme à sa
source** (`check`). Il ne sait pas dire que sa **forme** n'est plus celle que
l'état de l'art recommande. Ce sont deux diagnostics distincts, et les
confondre produirait un outil qui crie au loup sur des dérives inexistantes.

Les tâches [25](25-pack-usage-collecte.md), [30](30-pack-usage-analyse.md) et
[28](28-budget-de-contexte.md) fournissent les **mesures** — ce qui sert, ce que
ça coûte. Ce qui manque ici est la **norme appliquée à ces mesures** : « cette
description dépasse la borne recommandée », « ce skill gagnerait à être découpé
en progressive disclosure ». Un skill qui sert et qui est léger peut rester un
skill mal formé ; aucune des trois tâches de mesure ne le dira.

## Pourquoi ce périmètre

L'exemple qui a motivé cette tâche — « depuis Opus 5, Anthropic recommande
moins de skills » — a été vérifié aux sources primaires le 30 août 2026. Le
résultat est instructif :

- **Vérifié** : le billet d'Anthropic du 24 juillet 2026 sur le context
  engineering pour les modèles de génération Claude 5 recommande de
  **simplifier** system prompts, skills et fichiers de contexte, d'éviter les
  skills surcontraints, et d'appliquer la progressive disclosure en découpant
  les skills longs en plusieurs fichiers.
- **Non vérifié** : aucune source primaire ne recommande de réduire le
  **nombre** de skills. La documentation de référence traite « 100+ skills »
  comme un cas normal, et le même billet recommande d'en créer un.

La prémisse était donc à moitié inexacte. C'est la démonstration du risque que
porte la voie « veille active » : construire une fonctionnalité sur une opinion
extérieure datée, propagée en paraphrases, revient à faire vieillir l'outil au
rythme d'un flux qu'il ne contrôle pas. **Les normes vivent dans la version de
la CLI et se livrent par npm**, comme pour tout outil de développement.

## Ce que la vérification a rapporté d'utilisable

Deux acquis, à réutiliser plutôt qu'à redécouvrir :

- **Les bornes de la spécification Agent Skills** : `name` ≤ 64 caractères,
  `description` ≤ 1 024 caractères, `compatibility` ≤ 500 caractères, corps de
  `SKILL.md` sous 5 000 tokens recommandés et sous 500 lignes, métadonnées de
  l'ordre de la centaine de tokens chargées au démarrage pour l'ensemble des
  skills.
- **Une contrainte dure** : la spécification ne publie **ni numéro de version ni
  changelog**. On ne peut donc pas dater une norme par la version de sa source.
  Chaque norme est datée **à sa date de consultation, avec l'URL consultée** —
  exactement la convention que `core/hook-registries.ts` applique déjà aux
  formats de registres de hooks.

## Fichiers

- `src/core/conventions-dates.ts` — à créer : les normes en données, chacune
  avec sa borne, sa source et sa date de consultation.
- `src/core/validate.ts` — les invariants ; les bornes de la spec y trouvent
  leur place, en tant qu'informations et non en tant qu'erreurs bloquantes.
- `src/commands/doctor.ts` — le lieu du diagnostic, y compris l'âge de la CLI.
- `src/packs/creator.ts` — le méta-skill qui porte le jugement.
- `docs/conventions.md` — les bornes documentées et datées.

## Critères d'acceptation

- Les normes appliquées (bornes de taille, granularité recommandée, forme
  attendue) sont des **données versionnées**, chacune portant sa borne, sa
  source et sa date de consultation ; aucune n'est écrite en dur dans une
  condition du code.
- `doctor` affiche la date de publication de la CLI et la date des conventions
  qu'elle embarque, avec un avis explicite quand cet écart dépasse six mois.
- Ce diagnostic n'ouvre **aucune connexion réseau**, ce qui est vérifié par un
  test.
- Un méta-skill du pack `creator` confronte la forme de la configuration du
  dépôt aux normes datées et produit des propositions argumentées, chacune
  citant la norme, sa source et sa date.
- Le rapport distingue explicitement quatre diagnostics et ne les mélange
  jamais : la configuration a **dérivé** (`check`), elle ne **sert** pas
  (tâche 30), elle **coûte** (tâche 28), sa **forme** n'est plus celle
  recommandée (cette tâche).
- Aucune modification n'est appliquée automatiquement : l'outil propose, l'équipe
  décide.
- Rien ne sort du dépôt, sans exception.

## Notes d'implémentation

**Le dépassement d'une borne informe, il ne fait pas échouer.** `check` reste le
gardien de la dérive ; la sobriété et la forme relèvent de `doctor`, dont la
promesse est de diagnostiquer sans faire échouer. Cette séparation est la même
que celle posée par la tâche 28, et pour la même raison.

**L'âge de la CLI se calcule sans réseau**, sur une date de publication
embarquée à la construction du paquet. Interroger le registre npm enverrait le
nom du paquet hors du dépôt : si cette option est ajoutée un jour, ce sera
derrière un drapeau explicite, jamais par défaut, et jamais dans `check`.

**Le jugement est un skill, pas du code.** « Ces cinq skills gagneraient à
fusionner » est une appréciation, et le projet sépare partout le déterministe
(la CLI) de l'appréciation (le skill). Le canal de mise à jour reste le même :
le pack, donc npm.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js check && node dist/cli.js doctor
```

Puis, sur un dépôt de démonstration : fabriquer un skill dont la description
dépasse la borne, vérifier que `doctor` le signale et que `check` reste vert ;
antidater les conventions embarquées et vérifier que l'avis de vieillissement
apparaît ; vérifier par test qu'aucune requête réseau n'est émise.

## Hors périmètre

- **La veille active sur des sources externes** — écartée le 30 août 2026, pour
  la raison exposée plus haut.
- **La commande `update`**, qui fait migrer une structure d'un schéma au
  suivant : c'est la tâche [31](31-commande-update.md), dont celle-ci ne dépend
  pas.
- Modifier la configuration d'un dépôt sur la foi d'une recommandation.
  L'outil informe et propose ; l'équipe décide.
