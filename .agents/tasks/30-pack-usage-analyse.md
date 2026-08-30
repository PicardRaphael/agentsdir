# 30 — Pack `usage`, étage 2 : l'analyse

> Second étage de la tâche [25](25-pack-usage-collecte.md), dont elle consomme
> le journal. **Dépend de :** 25 livrée, et d'un délai d'observation réel.

## Problème

La collecte écrit un journal ; elle n'en tire aucune conclusion. Cette tâche
livre la conclusion : un compte rendu qui dit ce qui sert, ce qui ne sert
jamais, et — c'est le point le plus important — **ce que la mesure ne peut pas
dire**.

## Pourquoi c'est une tâche séparée

Deux raisons, et la seconde est la vraie.

La première est structurelle : la collecte est déterministe et testable, le
jugement ne l'est pas. Le projet sépare partout ces deux natures, et les livrer
ensemble mélangerait dans un même commit du code vérifiable et une appréciation.

La seconde est une question de calendrier. **Le jour de sa livraison, un rapport
d'usage est vide** : il faut des semaines de sessions observées pour qu'il dise
quoi que ce soit. Livrer la collecte tôt fait mûrir les données pendant que le
reste se construit ; livrer les deux ensemble produirait un rapport qui n'a rien
à rapporter, donc une fonctionnalité qu'on ne peut ni démontrer ni valider.

## Le point dur, hérité de la collecte

**Les règles ne sont pas invocables.** Le rapport ne doit donc jamais parler
d'usage pour une règle, mais de **pertinence** : son périmètre a-t-il recoupé
les fichiers touchés au cours des sessions observées. Une règle jamais
pertinente sur des dizaines de sessions est une règle morte, et c'est une
conclusion actionnable — plus honnête que « a-t-elle été lue », à quoi rien ne
permet de répondre.

Ce que la mesure ne peut pas dire doit figurer dans le rapport, faute de quoi
l'utilisateur lui prêtera une autorité qu'elle n'a pas.

## Croisement avec le coût

Le rapport prend tout son sens croisé avec la tâche [28](28-budget-de-contexte.md) :
l'usage dit **si** un élément sert, le coût dit **combien** il coûte. Ensemble
ils répondent à la seule question qui intéresse une équipe : *ce skill vaut-il
ce qu'il coûte ?*

Ce croisement n'est pas une invention produit. Claude Code effectue déjà cet
arbitrage en silence : quand le listing des skills dépasse son budget de
contexte, il raccourcit puis supprime les descriptions **en commençant par les
skills les moins invoqués**. Le rapport rend visible et discutable une décision
que le harness prend aujourd'hui dans le dos de l'équipe. C'est l'argument le
plus fort de cette tâche, et il mérite d'être écrit tel quel dans le compte
rendu.

## Fichiers

- `src/packs/usage.ts` — le pack livré par la tâche 25, à compléter du
  méta-skill d'analyse.
- `docs/conventions.md` — le format du journal, contrat établi par la tâche 25.
- `docs/creation-assistee.md` — le protocole des méta-skills, à compléter.

## Critères d'acceptation

- Un méta-skill lit le journal et produit un compte rendu qui distingue trois
  catégories : ce qui est utilisé, ce qui ne l'est jamais, et **ce que la mesure
  ne peut pas dire**.
- Pour les règles, le rapport parle de pertinence (périmètre recoupé) et non
  d'usage, en énonçant explicitement cette limite.
- Chaque proposition de suppression cite les données qui la motivent — nombre de
  sessions observées, dernière occurrence — et reste une proposition : rien
  n'est supprimé automatiquement.
- Le rapport indique le volume d'observation sur lequel il s'appuie et
  **refuse de conclure** en dessous d'un seuil de sessions, plutôt que de
  produire une statistique sur trois points.
- Quand la tâche 28 est livrée, le rapport croise usage et coût ; tant qu'elle
  ne l'est pas, il le signale au lieu de faire comme si le coût était nul.
- Le compte rendu est un document Markdown lisible dans le terminal comme dans
  une revue de code.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js check
```

Puis, sur un dépôt de démonstration portant un journal fabriqué couvrant
plusieurs semaines simulées : dérouler le skill d'analyse, vérifier que le
classement correspond aux données, qu'une règle jamais pertinente est signalée
comme telle et non comme « jamais lue », et qu'un journal trop court fait
refuser la conclusion.

## Hors périmètre

- La collecte elle-même : tâche 25.
- La suppression automatique de contenu jugé inutile : l'outil propose, il ne
  décide pas.
- Un tableau de bord : un compte rendu Markdown suffit.
