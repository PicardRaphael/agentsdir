# 39 — Maintenance activable de la configuration du dépôt

> Demandée par l'utilisateur le 12 septembre 2026, à la suite de la tâche 24.
> Trois points de périmètre restent à trancher : ils sont isolés dans la
> section « À trancher avant de prendre la tâche ». Les critères d'acceptation
> ci-dessous sont écrits sous les hypothèses qui y sont déclarées ; si
> l'utilisateur tranche autrement, ce sont les critères qu'il faut réécrire,
> pas le code qu'il faut improviser.

## Problème

Un dépôt configuré il y a six mois porte des skills, des règles, des
sous-agents et un `AGENTS.md` que **son équipe** a écrits. Rien ne l'aide à les
garder en phase avec ce que les harness et les modèles supportent aujourd'hui :
un champ de frontmatter a gagné une option, une pratique a été révisée à la
source, un format d'événement a bougé. L'équipe ne le sait pas, et l'agent
continue de lire une configuration qui a vieilli sans le dire.

Aucune commande ne couvre ça :

| Ce qui existe | Ce que ça fait | Ce que ça ne fait pas |
| --- | --- | --- |
| `check` | Vérifie qu'une configuration est **conforme à sa source** | Ne dit rien de son actualité |
| `update` (livré le 6 septembre 2026) | Met à jour le contenu que **la CLI** a installé | Ne touche jamais aux artefacts que l'équipe a écrits |
| Tâche [29](29-suivre-l-evolution-des-pratiques.md) | Confronte la **forme** de la configuration à des normes datées, embarquées dans la version de la CLI | Pas d'interrupteur ; périmètre arrêté **sans réseau** |
| Méta-skills du pack `creator` | Consultent les sources primaires **au moment de créer** un artefact (livré le 12 septembre 2026) | Ne repassent jamais sur ce qui existe déjà |

Ce qui manque est la jonction des deux dernières lignes : une maintenance que
l'équipe **active ou non**, qui repasse sur ce que le dépôt possède déjà et
propose, artefact par artefact, ce qui gagnerait à changer — avec la preuve.

## À trancher avant de prendre la tâche

Ces trois points changent les critères d'acceptation. Ils ont été posés à
l'utilisateur le 12 septembre 2026 et sont restés sans réponse ; l'hypothèse
retenue est indiquée pour chacun, et elle est défendable, pas définitive.

1. **Proposer ou appliquer ?** — *Hypothèse : proposer seulement.* Le dépôt
   sépare partout le déterministe (la CLI écrit) de l'appréciation (le skill
   propose), et la tâche 29 pose déjà « aucune modification n'est appliquée
   automatiquement ». Un interrupteur qui autoriserait l'application
   automatique rouvrirait ce principe.
2. **À la demande, ou aussi en CI ?** — *Hypothèse : à la demande seulement.*
   `check` est le gardien de la CI et doit rester déterministe et hors ligne ;
   un diagnostic qui dépend d'une consultation extérieure ne peut pas décider
   d'un build. C'est la même séparation que les tâches 28 et 29.
3. **Faut-il rouvrir le périmètre sans réseau de la tâche 29 ?** — *Hypothèse :
   non, parce que la tension est apparente.* Ce que la 29 a écarté le
   30 août 2026, c'est que **la CLI** fasse de la veille : `check` et `doctor`
   n'ouvrent aucune connexion, et un test le prouve. Ce que fait la maintenance
   décrite ici, c'est que **l'agent** consulte les sources primaires pendant une
   session que l'utilisateur regarde — exactement ce que les méta-skills de
   création font depuis le 12 septembre 2026. Les deux cohabitent si la
   frontière est tenue : la CLI reste hors ligne, le skill consulte.
   **Si l'utilisateur veut que la CLI aille elle-même au réseau**, alors la
   décision du 30 août est rouverte et cette tâche doit être réécrite.

## Fichiers

- `src/packs/creator.ts` — le méta-skill de maintenance ; `currentPracticeBullets`
  y porte déjà la discipline des sources primaires datées, à réutiliser sans la
  dupliquer.
- `src/core/manifest.ts` — le manifeste ; l'interrupteur y vit, comme le mode de
  projection (`docs/architecture.md` fait foi sur la forme du manifeste).
- `src/commands/doctor.ts` — le lieu du diagnostic non bloquant, si la tâche 29
  est livrée avant.
- `docs/creation-assistee.md` — le protocole, à compléter de la boucle de
  maintenance.
- `docs/commandes.md` — la section du manifeste et celle du pack `creator`.
- `.agents/tasks/29-suivre-l-evolution-des-pratiques.md` — la tâche voisine :
  lire sa section « Pourquoi ce périmètre » avant d'écrire une ligne.

## Critères d'acceptation

- Un interrupteur explicite vit dans `.agents.toml` ; **absent, la maintenance
  ne se déclenche jamais**, et un dépôt qui ne l'active pas ne voit aucune
  différence de comportement.
- Un méta-skill du pack `creator` repasse sur les artefacts que **le dépôt**
  possède — `.agents/skills/`, `.agents/rules/`, `.agents/agents/`, `AGENTS.md`
  et ses projections — et produit une proposition par artefact.
- Chaque proposition cite la source primaire qui la motive, avec sa date de
  consultation, et distingue ce qui a été lu de ce qui est supposé. Une
  proposition sans source datée n'est pas faite.
- Chaque proposition est acceptable, refusable ou amendable **individuellement**,
  et rien n'est écrit avant que chaque ligne ait son verdict — le protocole de
  `$propose-setup`, réutilisé et non redit.
- Ce qui est accepté est appliqué par les méta-skills existants (`$create-skill`,
  `$create-rule`, `$create-agent`, `$setup-context`) et passe `agentsdir check`
  du premier coup.
- Le contenu installé par la CLI est **hors périmètre du skill** : il appartient
  à `update`, et la maintenance renvoie vers lui au lieu d'y toucher.
- Aucune commande de la CLI n'ouvre de connexion réseau ; un test le prouve, au
  même titre que celui de la tâche 29.
- Le rapport distingue ce qui a été proposé, ce qui a été refusé avec sa raison,
  et ce qu'aucune source consultée ne justifiait de changer.

## Notes d'implémentation

**La maintenance ne doit pas devenir une cinquième façon de dire la même chose.**
Le dépôt distingue déjà quatre diagnostics — la configuration a *dérivé*
(`check`), elle ne *sert* pas (tâche 30), elle *coûte* (tâche 28), sa *forme*
n'est plus celle recommandée (tâche 29). Celui-ci est le cinquième : elle n'est
plus *à jour* de ce que la source publie. Si l'écriture des critères montre que
ce cinquième diagnostic se confond avec celui de la 29, alors les deux tâches
fusionnent — et c'est une décision à prendre avec l'utilisateur, pas un arbitrage
d'implémentation.

**Le silence est un résultat.** Une exécution qui ne propose rien parce que rien
n'a bougé doit le dire clairement. Un outil de maintenance qui trouve toujours
quelque chose à changer est un outil qu'on désactive au bout de trois passages.

**Pas de veille en tâche de fond.** L'interrupteur autorise la maintenance à
consulter quand l'utilisateur la lance ; il n'autorise rien qui tourne seul.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js check && node dist/cli.js doctor
```

Puis, sur deux dépôts de démonstration : l'un sans l'interrupteur, où la
maintenance ne se déclenche pas et où rien ne change ; l'autre avec, où la
proposition est déroulée en réponses scriptées, chaque ligne acceptée ou
refusée, et où `check` reste vert. Vérifier par test qu'aucune requête réseau
n'est émise par la CLI.

## Hors périmètre

- **La mise à jour du contenu installé par la CLI** : c'est `update`, livré le
  6 septembre 2026.
- **L'application automatique d'une proposition**, sous l'hypothèse 1 ci-dessus.
- **Toute exécution déclenchée par la CI ou par une session**, sous
  l'hypothèse 2 ci-dessus.
- **La veille active par la CLI elle-même**, écartée le 30 août 2026 par la
  tâche 29 et non rouverte ici.
