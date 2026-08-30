# 29 — Aider un dépôt à suivre l'évolution des pratiques

> Tâche **à discuter avant d'être implémentée** : l'idée est bonne, son
> périmètre ne l'est pas encore. Voir la section « Ce qu'il faut trancher ».

## Problème

Les pratiques bougent plus vite que les dépôts. Exemple donné par l'utilisateur :
depuis Opus 5, la recommandation d'Anthropic va vers **moins** de skills, mieux
ciblés — l'inverse de ce que beaucoup d'équipes ont fait pendant un an. Un dépôt
configuré il y a six mois porte donc une structure qui était une bonne pratique
et ne l'est plus, sans que rien ne le signale.

Le produit sait aujourd'hui vérifier qu'une configuration est **conforme à sa
source**. Il ne sait pas dire qu'elle est **périmée par rapport à l'état de
l'art**.

## Ce qu'il faut trancher

Le besoin se décompose en deux problèmes très différents, et les confondre
mènerait à construire la mauvaise chose.

**1. « Ma configuration est-elle encore utile ? »** — largement couvert par les
tâches [25](25-pack-usage-boucle-de-retroaction.md) et
[28](28-budget-de-contexte.md). Si l'on sait quels skills ne servent jamais et
ce qu'ils coûtent, on sait lesquels supprimer — et cette réponse reste vraie
quelle que soit la recommandation du moment. C'est la voie robuste : elle repose
sur les données du dépôt, pas sur une opinion extérieure qui changera encore.

**2. « Les conventions ont-elles changé ? »** — un problème d'un autre ordre.
Les formats de registres de hooks, la spécification Agent Skills, MCP évoluent.
Le dépôt voudrait savoir que ce qu'il applique n'est plus la forme courante.

Trois façons de traiter le second, par coût et par risque croissants :

- **Par version de la CLI** : `agentsdir` embarque ce qu'il sait des conventions
  à la date de sa publication ; `doctor` signale quand la CLI est ancienne et
  qu'une version plus récente connaît d'autres formats. Aucun réseau, aucune
  surveillance — le canal de mise à jour est npm, comme pour tout outil.
- **Par migration explicite** : la commande `update` déjà prévue en v1.x, qui
  fait évoluer la structure d'un schéma au suivant.
- **Par veille active** : une boucle qui consulte des sources externes. C'est ce
  que l'utilisateur a évoqué, et c'est le plus délicat : cela contredit le
  principe « aucune remontée réseau », déplace la confiance vers une source
  extérieure, et fait vieillir l'outil au rythme d'un flux qu'il ne contrôle pas.
  Si cette voie est retenue, elle doit être désactivée par défaut, explicitement
  activée, et n'émettre que des propositions à valider.

**La question à trancher avec l'utilisateur** : le besoin réel est-il « supprimer
ce qui ne sert plus » (déjà outillé par 25 et 28, sans réseau) ou « connaître
l'état de l'art » (qui suppose une source extérieure et sa fiabilité) ? Les deux
méritent une réponse, mais pas la même.

## Fichiers

- `.agents/tasks/25-pack-usage-boucle-de-retroaction.md` — la mesure d'usage.
- `.agents/tasks/28-budget-de-contexte.md` — la mesure de coût.
- `src/commands/doctor.ts` — le lieu d'un diagnostic « votre CLI est ancienne ».
- `src/core/manifest.ts` — la version de schéma, socle de `update`.
- `docs/positionnement.md` — la direction, à respecter : la mesure locale
  d'abord.

## Critères d'acceptation

À écrire une fois le périmètre tranché. Une contrainte tient déjà quel que soit
le choix : **rien ne part du dépôt vers l'extérieur sans demande explicite**, et
toute recommandation reste une proposition argumentée, jamais une modification
automatique.

## Hors périmètre

Modifier la configuration d'un dépôt sur la foi d'une recommandation externe.
L'outil peut informer et proposer ; l'équipe décide.
