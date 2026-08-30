# 25 — Pack `usage` : savoir si la configuration sert vraiment

## Problème

`check` garantit qu'une configuration n'a pas dérivé. Rien ne dit si elle
**sert**. Un skill que personne n'invoque, un sous-agent jamais délégué, un hook
qui ne se déclenche sur aucun événement réel, une règle dont le périmètre ne
recoupe jamais les fichiers touchés : tout cela reste dans le dépôt, se projette
dans les trois harness, et coûte du contexte à chaque session — sans que
personne ne puisse le savoir.

C'est l'angle mort symétrique de la dérive. Le produit sait déjà répondre à
« la configuration correspond-elle à sa source ? ». Il ne sait pas répondre à
« cette configuration a-t-elle une utilité ? », qui est la question que se pose
un utilisateur au bout de trois mois.

L'infrastructure de collecte existe déjà : `agentsdir` enregistre des hooks
portables sur Claude Code, Codex et Cursor, et les événements disponibles
(`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`) suffisent à observer ce
qui se passe. C'est une capacité qu'aucun outil comparable ne possède, parce
qu'aucun n'installe de hooks multi-harness.

## Le point dur, à traiter de front

**Les règles ne sont pas invocables, donc pas directement observables.** Skills,
sous-agents et hooks sont appelés — leur usage se trace. Une règle est injectée
dans le contexte : aucun hook ne dira si l'agent l'a lue.

La mesure utile n'est donc pas la lecture mais la **pertinence** : une règle
déclare son périmètre (`add rule --paths "src/api/**"`), la session a touché
`src/api/x.ts`, la règle était pertinente pour cette session. Une règle qui
n'est jamais pertinente sur des dizaines de sessions est une règle morte, et
c'est une conclusion actionnable — plus utile que « a-t-elle été lue ».

Ce que la mesure ne peut pas dire doit être dit explicitement dans le rapport,
faute de quoi l'utilisateur lui prêtera une autorité qu'elle n'a pas.

## Fichiers

- `src/packs/` — nouveau pack `usage`, sur le modèle de `verification.ts`.
- `src/core/hook-registries.ts` — les événements et l'enregistrement, déjà là.
- `src/templates/hook.ts` — le gabarit de script portable, déjà là.
- `src/packs/index.ts` — une entrée dans `PACK_REGISTRY`.
- `src/commands/init.ts` — le pack reste optionnel, jamais installé par défaut.
- `.gitignore` (bloc géré) — le journal ne doit jamais être versionné.

## Notes d'implémentation

**Deux étages, séparés comme partout ailleurs dans ce projet.**

1. *Collecte* — des scripts de hooks qui ajoutent une ligne JSON à un journal
   local. Déterministe, testable, sans jugement. C'est de la CLI.
2. *Analyse* — un méta-skill qui lit le journal, produit un compte rendu et
   propose des changements. C'est du jugement, donc un skill, pas du code.

**Vie privée, non négociable.** Cet outil s'installe dans le dépôt de quelqu'un
d'autre — dépôt privé, dépôt client, dépôt sous NDA. Trois niveaux de risque, et
le troisième est le plus facile à sous-estimer :

1. *Le contenu.* Les payloads de hooks portent les prompts de l'utilisateur et
   des extraits de fichiers. Rien de tout cela n'est journalisé, jamais.
2. *Les chemins.* Un chemin est lui-même une donnée :
   `src/clients/acme/contrat-2026.ts` nomme un client. Le journal ne retient que
   des chemins **relatifs à la racine** — jamais absolus, qui révéleraient en
   plus l'arborescence et le nom de session de la machine. Prévoir un moyen
   d'exclure des sous-arbres (mêmes globs que `add rule --paths`), pour qu'un
   dépôt sensible puisse mesurer son usage sans consigner où.
3. *La fuite par commit.* Le vrai danger n'est pas le journal, c'est le journal
   **versionné par mégarde**. Le bloc géré de `.gitignore` couvre déjà
   `.agents/output/`, mais une convention n'est pas une garantie : `check` doit
   **échouer** si le journal est suivi par git. Un garde actif, au même titre que
   les autres invariants.

Le journal vit donc sous `.agents/output/`, jamais sous `.agents/memory/` qui a
un autre rôle, et ne retient que : horodatage, type d'événement, nom d'outil,
chemin relatif (filtrable), nom du skill ou du sous-agent invoqué.

**Coût.** Un hook sur `PreToolUse` s'exécute à chaque appel d'outil : le script
doit se limiter à un `appendFile` d'une ligne, sans lecture ni calcul. Mesurer
la latence ajoutée avant de conclure.

**Désactivation.** `pack remove usage` retire les scripts et déregistre les
hooks — le mécanisme existe déjà. Prévoir en plus un interrupteur qui suspend la
collecte sans désinstaller (variable d'environnement ou entrée du manifeste),
car un utilisateur voudra parfois une session non observée.

**Rotation.** Un journal qui grossit sans limite finit par coûter plus que ce
qu'il rapporte : borner par taille ou par ancienneté, et le dire dans la règle
installée par le pack.

## Critères d'acceptation

- `agentsdir pack add usage` installe des scripts de hooks portables qui
  journalisent, sur les trois harness, les invocations de skills et de
  sous-agents, les outils utilisés et les chemins touchés.
- Le journal ne contient aucun contenu de prompt ni de fichier — vérifié par un
  test qui fait passer un prompt reconnaissable et vérifie son absence.
- Le journal n'est jamais versionné : il vit sous `.agents/output/`, `git status`
  reste propre après une session observée, et `check` **échoue** si le journal
  est suivi par git — la protection est vérifiée, pas seulement conventionnelle.
- Les chemins journalisés sont relatifs à la racine du dépôt, et un dépôt peut
  exclure des sous-arbres de la journalisation.
- Un méta-skill produit un compte rendu qui distingue trois catégories : ce qui
  est utilisé, ce qui ne l'est jamais, et **ce que la mesure ne peut pas dire**.
- Pour les règles, le rapport parle de pertinence (périmètre recoupé) et non
  d'usage, en énonçant cette limite.
- Chaque proposition de suppression cite les données qui la motivent — nombre de
  sessions observées, dernière occurrence — et reste une proposition : rien
  n'est supprimé automatiquement.
- La collecte se suspend sans désinstaller le pack.
- `pack remove usage` retire scripts, enregistrements et journal.
- Le surcoût par appel d'outil est mesuré et consigné.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js check
```

Puis, sur un dépôt de démonstration : installer le pack, simuler une série
d'événements en invoquant les scripts avec des payloads représentatifs des trois
harness, vérifier le contenu du journal (métadonnées seulement), dérouler le
skill d'analyse, et confirmer que `pack remove usage` ne laisse rien derrière.

## Hors périmètre

- Toute remontée réseau : la télémétrie reste locale, sans exception. C'est un
  outil de développement installé par `npx` dans le dépôt de quelqu'un.
- La suppression automatique de contenu jugé inutile : l'outil propose, il ne
  décide pas.
- Un tableau de bord : un compte rendu Markdown suffit et se lit dans le
  terminal comme dans une revue de code.
