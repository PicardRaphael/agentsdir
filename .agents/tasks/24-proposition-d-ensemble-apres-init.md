# 24 — Proposer un ensemble cohérent après `init`

## Problème

Après `agentsdir init`, un dépôt qui n'avait aucune configuration d'agent
repart avec une structure vide : `.agents/rules/` ne contient que les règles
génériques, `.agents/hooks/` et `.agents/agents/` sont vides, `.agents/skills/`
n'a que les méta-skills du pack `creator`. L'utilisateur a le squelette, pas le
contenu — et rien ne lui dit ce qui aurait du sens pour *son* dépôt.

Les méta-skills existants couvrent la création **à l'unité**, sur demande :
`$create-skill`, `$create-rule`, `$create-hook`, `$create-agent`. Et
`$setup-context` analyse le dépôt pour rédiger `AGENTS.md`, avec pré-rédaction,
interview de validation et critique ligne par ligne. Le protocole est donc déjà
là, mais appliqué à un seul artefact : le point d'entrée.

Ce qui manque : une **proposition d'ensemble**. Après analyse du dépôt — sa
stack, ses scripts, sa CI, ses conventions observables, ce que le linter
applique déjà — présenter les règles, hooks et sous-agents qui auraient du sens
ici, avec pour chacun la raison, et laisser l'utilisateur accepter, refuser ou
amender avant écriture.

C'est le prolongement direct du positionnement affiché dans
[`docs/creation-assistee.md`](../../docs/creation-assistee.md) : la création
assistée est le cœur du produit, et l'inventaire du dépôt en est la première
étape. La proposition d'ensemble est l'étape qui manque entre « l'architecture
est installée » et « l'utilisateur sait quoi en faire ».

## Fichiers

- `src/packs/creator.ts` — les méta-skills ; l'endroit où ajouter le nouveau.
- `src/packs/creator.ts` (`setupContextMeta`) — le protocole à réutiliser :
  inventaire, pré-rédaction, interview du non-découvrable, critique.
- `src/core/detect.ts` — `detectStack`, `detectHarnesses` : ce que la CLI sait
  déjà lire du dépôt sans rien demander.
- `docs/creation-assistee.md` — le protocole de référence, à compléter.
- `src/commands/init.ts` — le message de fin, qui doit orienter vers ce skill.

## Notes d'implémentation

Le levier est le skill, pas la CLI : l'analyse d'un dépôt et le dialogue avec
l'utilisateur relèvent de l'agent, pas d'un programme déterministe. La CLI
fournit les faits (stack, commandes, harness détectés) ; le skill propose et
l'utilisateur tranche.

Deux écueils à éviter, tous deux visibles chez les outils comparables :

- **Proposer trop.** Une liste de quinze règles génériques est plus nuisible
  qu'une page blanche : elle sera acceptée sans lecture, puis ignorée. La règle
  du repo s'applique — « si cette ligne disparaît, l'agent se trompe-t-il ? »
  Une proposition qui ne passe pas ce filtre ne doit pas être faite.
- **Proposer ce qu'un outil applique déjà.** Ce qu'un linter, la CI ou un hook
  garantissent mécaniquement n'a pas à devenir une règle écrite. `setup-context`
  applique déjà ce critère ; le nouveau skill doit l'appliquer aussi.

Une piste de valeur, à valider avec l'utilisateur : proposer en priorité les
hooks, car c'est ce qu'un dépôt ne peut pas obtenir autrement et ce que peu
d'outils installent — la règle et le sous-agent se rédigent facilement à la
main, le hook multi-harness beaucoup moins.

## Critères d'acceptation

- Un méta-skill du pack `creator` analyse le dépôt et présente une proposition
  d'ensemble : règles, hooks, sous-agents, chacun avec la raison qui le
  justifie dans **ce** dépôt.
- Chaque élément proposé est acceptable, refusable ou amendable
  individuellement ; rien n'est écrit avant validation.
- La proposition cite ce sur quoi elle s'appuie (stack détectée, scripts du
  `package.json`, workflow de CI, conventions observées) et distingue ce
  qu'elle a lu de ce qu'elle suppose.
- Aucun élément n'est proposé quand un outil du dépôt l'applique déjà.
- Ce qui est accepté est créé via les méta-skills existants, sans dupliquer leur
  protocole, et passe `agentsdir check` du premier coup.
- Sur un dépôt qui a déjà des règles ou des hooks, le skill complète au lieu de
  proposer des doublons.
- Le message de fin d'`init` mentionne le skill.
- `docs/creation-assistee.md` décrit le protocole ajouté.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js check
```

Puis, sur deux dépôts de démonstration (un TypeScript avec CI et linter, un
Python sans rien) : dérouler le skill en réponses scriptées, vérifier que les
artefacts créés passent `check`, et qu'aucune proposition ne double ce que le
linter ou la CI applique déjà.

## Hors périmètre

Une bibliothèque de règles et de hooks prêts à l'emploi, téléchargée depuis un
catalogue distant : c'est `vendor` (v1.x), et cette tâche n'en dépend pas.
