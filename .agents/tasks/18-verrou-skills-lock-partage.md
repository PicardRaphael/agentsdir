# 18 — Un seul planificateur pour `skills-lock.json`

## Problème

Trois modules planifient le même fichier, chacun à sa façon :

- `commands/init.ts` (`buildPlan`) sème le verrou avec `renderLockSeed`.
- `commands/pack.ts` (`planLockWith`) fusionne des entrées `agentsdirLockEntry`
  et sait en retirer.
- `commands/sync.ts` (`planLock`) recalcule `computedHash` des entrées
  `sourceType: "github"` via `computeSkillHash`.

Deux chemins de hachage coexistent par ailleurs — `computeSkillHash` (depuis le
disque) et `packSkillHash` (depuis les fichiers rendus en mémoire) — qui
convergent bien vers `hashSkillFiles`, mais dont le choix est implicite à chaque
appel.

Le verrou est le mécanisme qui protège le contenu de l'utilisateur lors d'un
futur `update` (`docs/conventions.md` §7). Trois implémentations de sa mise à
jour, c'est trois occasions de diverger sur la question qui compte : quelles
entrées sont re-verrouillées, lesquelles restent épinglées.

## Fichiers

- `src/commands/sync.ts` — `planLock` (re-verrouillage des entrées `github`).
- `src/commands/pack.ts` — `planLockWith` (delta ajout/retrait).
- `src/commands/init.ts` — `buildPlan`, semis via `renderLockSeed`.
- `src/packs/index.ts` — `packSkillHash`, `agentsdirLockEntry`, `renderLockSeed`.
- `src/core/validate.ts` — `computeSkillHash`, `hashSkillFiles`, `validateLock`.
- `docs/conventions.md` §7 — le contrat du verrou.

## Notes d'implémentation

`packSkillHash` (fichiers en mémoire) et `computeSkillHash` (disque) doivent
rester tous deux disponibles : le premier sert au `--dry-run`, le second au
contrôle. Les unifier n'est pas l'objet de la tâche ; rendre explicite lequel
s'applique, si.

## Critères d'acceptation

- Un module unique (`commands/lock.ts` ou `core/lock.ts` selon ses dépendances)
  porte : lecture, validation de forme, application d'un delta (ajout, retrait),
  re-verrouillage des entrées `github`, épinglage des entrées `agentsdir`.
- `init`, `pack add`, `pack remove` et `sync` l'utilisent ; aucun ne lit ni
  n'écrit `skills-lock.json` directement.
- Comportement strictement préservé : une entrée `sourceType: "agentsdir"`
  modifiée localement reste une **information**, jamais une erreur ; une entrée
  `github` qui dérive reste une **erreur** (`docs/conventions.md`, invariant 10).
- Le rendu du fichier est inchangé octet pour octet (clés triées, indentation).
- Les tests existants du verrou passent sans modification de leurs assertions.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js sync && node dist/cli.js check
```

## Hors périmètre

La commande `vendor` (v1.x) et la protection `update` elle-même : cette tâche
consolide l'existant, elle n'ajoute aucune capacité.
