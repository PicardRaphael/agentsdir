# 25 — Pack `usage`, étage 1 : la collecte

> Scindée en deux le 30 août 2026. La collecte (ce fichier) est déterministe et
> se livre seule ; l'analyse est la tâche [30](30-pack-usage-analyse.md). La
> raison de la scission est en tête de cette dernière.

## Problème

`check` garantit qu'une configuration n'a pas dérivé. Rien ne dit si elle
**sert**. Un skill que personne n'invoque, un sous-agent jamais délégué, un hook
qui ne se déclenche sur aucun événement réel, une règle dont le périmètre ne
recoupe jamais les fichiers touchés : tout cela reste dans le dépôt, se projette
dans les trois harness, et coûte du contexte à chaque session — sans que
personne ne puisse le savoir.

C'est l'angle mort symétrique de la dérive. Le produit sait répondre à « la
configuration correspond-elle à sa source ? ». Il ne sait pas répondre à « cette
configuration a-t-elle une utilité ? », qui est la question que se pose un
utilisateur au bout de trois mois.

L'infrastructure de collecte existe déjà : `agentsdir` enregistre des hooks
portables sur Claude Code, Codex et Cursor, et les événements disponibles
(`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`) suffisent à observer ce
qui se passe. C'est une capacité qu'aucun outil comparable ne possède, parce
qu'aucun n'installe de hooks multi-harness.

**Cette tâche ne livre que l'observation.** Elle ne produit aucun rapport et ne
formule aucun jugement : elle écrit un journal exploitable, et s'arrête là.

## Le point dur, à traiter de front

**Les règles ne sont pas invocables, donc pas directement observables.** Skills,
sous-agents et hooks sont appelés — leur usage se trace. Une règle est injectée
dans le contexte : aucun hook ne dira si l'agent l'a lue.

Ce que le journal peut porter est donc la **pertinence** et non la lecture : une
règle déclare son périmètre (`add rule --paths "src/api/**"`), la session a
touché `src/api/x.ts`, la règle était pertinente pour cette session. Les chemins
touchés doivent donc être journalisés d'une façon qui permette ce recoupement en
aval, sans que la collecte ait à le faire elle-même.

## Fichiers

- `src/packs/` — nouveau pack `usage`, sur le modèle de `verification.ts`.
- `src/core/hook-registries.ts` — les événements et l'enregistrement, déjà là.
- `src/templates/hook.ts` — le gabarit de script portable, déjà là.
- `src/packs/index.ts` — une entrée dans `PACK_REGISTRY`.
- `src/commands/init.ts` — le pack reste optionnel, jamais installé par défaut.
- `src/core/validate.ts` — le garde qui fait échouer `check` si le journal est
  suivi par git.
- `.gitignore` (bloc géré) — le journal ne doit jamais être versionné.

## Critères d'acceptation

- `agentsdir pack add usage` installe des scripts de hooks portables qui
  journalisent, sur les trois harness, les invocations de skills et de
  sous-agents, les outils utilisés et les chemins touchés.
- Le journal ne contient aucun contenu de prompt ni de fichier — vérifié par un
  test qui fait passer un prompt reconnaissable et vérifie son absence.
- Le journal n'est jamais versionné : il vit sous `.agents/output/`, `git status`
  reste propre après une session observée, et `check` **échoue** si le journal
  est suivi par git — la protection est vérifiée, pas seulement conventionnelle.
- Les chemins journalisés sont relatifs à la racine du dépôt, jamais absolus, et
  un dépôt peut exclure des sous-arbres de la journalisation avec les mêmes
  globs que `add rule --paths`.
- La collecte se suspend sans désinstaller le pack.
- `pack remove usage` retire scripts, enregistrements et journal.
- Le journal est borné par taille ou par ancienneté, et la règle installée par
  le pack décrit cette rotation.
- Le surcoût par appel d'outil est mesuré et consigné.
- Le format du journal est documenté dans `docs/conventions.md` : c'est le
  contrat que la tâche 30 consommera.

## Notes d'implémentation

**Vie privée, non négociable.** Cet outil s'installe dans le dépôt de quelqu'un
d'autre — dépôt privé, dépôt client, dépôt sous NDA. Trois niveaux de risque, et
le troisième est le plus facile à sous-estimer :

1. *Le contenu.* Les payloads de hooks portent les prompts de l'utilisateur et
   des extraits de fichiers. Rien de tout cela n'est journalisé, jamais.
2. *Les chemins.* Un chemin est lui-même une donnée :
   `src/clients/acme/contrat-2026.ts` nomme un client. D'où les chemins
   relatifs et le filtrage par globs.
3. *La fuite par commit.* Le vrai danger n'est pas le journal, c'est le journal
   **versionné par mégarde**. Une convention n'est pas une garantie : `check`
   doit échouer, comme pour tout autre invariant.

Le journal vit sous `.agents/output/`, jamais sous `.agents/memory/` qui a un
autre rôle, et ne retient que : horodatage, type d'événement, nom d'outil,
chemin relatif (filtrable), nom du skill ou du sous-agent invoqué.

**Coût.** Un hook sur `PreToolUse` s'exécute à chaque appel d'outil : le script
doit se limiter à un `appendFile` d'une ligne, sans lecture ni calcul. Mesurer
la latence ajoutée avant de conclure.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js check
```

Puis, sur un dépôt de démonstration : installer le pack, simuler une série
d'événements en invoquant les scripts avec des payloads représentatifs des trois
harness, vérifier le contenu du journal (métadonnées seulement), vérifier que
`check` échoue si le journal est ajouté à l'index git, et confirmer que
`pack remove usage` ne laisse rien derrière.

## Hors périmètre

- **Le rapport et les propositions** : c'est la tâche
  [30](30-pack-usage-analyse.md).
- Toute remontée réseau : la télémétrie reste locale, sans exception.
- Un tableau de bord.
