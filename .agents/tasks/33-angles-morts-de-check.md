# 33 — Les angles morts de `check`

## Problème

Le produit vend une seule chose : **une configuration qui ne dérive pas**. Sept
dérives réelles passent aujourd'hui au vert. Chacune a été reproduite sur un
dépôt jetable au cours de l'audit du 30 août 2026, et vérifiée
contradictoirement par trois relectures indépendantes.

Ce ne sont pas des invariants manquants au sens de la tâche
[32](32-invariants-promis-non-tenus.md) — ceux-là sont annoncés et absents. Ici,
la vérification **existe** mais ne regarde pas au bon endroit.

### 1. Les enregistrements de hooks ne sont jamais comparés — bloquant

`validateHookRegistries` ne contrôle que la **forme** du registre (JSON valide,
objet au sommet). Elle ne compare jamais les enregistrements aux scripts
présents dans `.agents/hooks/`, alors que `sync` régénère précisément ce
contenu à partir d'eux (`src/commands/sync.ts:135` → `planHookRegistrations`).

La dérive passe dans les deux sens : un script ajouté sans `sync` n'est
enregistré nulle part — le harness ne l'exécute jamais, et la CI est verte ; un
script supprimé laisse des enregistrements orphelins que les trois harness
tenteront d'exécuter.

### 2. Un contenu déposé sous `.claude/` sans source est invisible — bloquant

En mode copie, `verifyCopies` ne compare que les fichiers **attendus** (dérivés
de `.agents/`) et, pour les orphelins, ne balaie que les clés de
`[projections.hashes]` du manifeste. Un dossier déposé dans `.claude/skills/`,
`.claude/agents/` ou `.claude/rules/` qui n'a jamais eu de source ni
d'empreinte n'est lu par aucun des deux chemins : ni signalé, ni supprimé. Le
harness, lui, le charge. C'est la négation directe de la promesse de
`docs/architecture.md:48`.

### 3. Un dossier de skill en lien symbolique échappe à toute validation

`validateSkills` ne descend que dans les entrées dont `entry.isDirectory()` est
vrai. Pour un `Dirent` de lien symbolique vers un dossier, c'est faux : le
dossier est ignoré en silence. En mode symlink, `.claude/skills` pointe sur
`.agents/skills` : le harness suit le lien et charge le `SKILL.md` que `check`
n'a jamais lu.

### 4. Invariant 3 inversé : un skill implicite sans restriction passe au vert

`skill-implicit-read-only` ne se déclenche que si `allowedTools` **existe** et
contient un outil d'écriture. Or `allowed-tools` est optionnel
(`docs/conventions.md:58`) et son absence signifie « aucune restriction »,
c'est-à-dire tous les outils, écriture comprise. Le cas le plus dangereux — un
skill implicite sans aucune restriction — est exactement celui que `check`
laisse passer.

### 5. Le bloc `rules-index` n'est jamais recalculé

`validateRulesIndex` se contente de deux tests de présence : chaque fichier de
`.agents/rules/` apparaît dans le bloc, chaque chemin cité existe. Le texte
« chemin — quand la lire », que `sync` régénère de façon déterministe depuis la
première ligne de chaque règle, n'est jamais comparé. Une règle dont le
propos change garde indéfiniment son ancienne description dans `AGENTS.md`.

### 6. Une seule violation de frontmatter à la fois, et dans le mauvais ordre

`validateFrontmatter` lève à la première erreur de champ : `check` n'en
rapporte qu'une par `SKILL.md`, tout en concluant « Check failed — 1
violation(s); each line above names the fix », ce qui laisse croire à
l'exhaustivité. Pire, l'invariant racine `name` = dossier n'est évalué
qu'ensuite : sur un `name` erroné, `check` fait corriger des symptômes avant la
cause.

## Fichiers

- `src/core/validate.ts` — `validateHookRegistries`, `validateSkills`,
  `validateRulesIndex`, la règle `skill-implicit-read-only`.
- `src/core/projections.ts` — `verifyCopies` et son balayage des orphelins.
- `src/core/frontmatter.ts` — `validateFrontmatter`, qui lève au lieu d'accumuler.
- `src/commands/sync.ts:135` — le plan de référence pour les registres.
- `src/commands/rules-index.ts` — le rendu déterministe de l'index.

## Critères d'acceptation

- `check` recalcule `planHookRegistrations` en mémoire et signale toute
  divergence avec le disque, dans les deux sens ; la règle est réparable par
  `sync` (entrée ajoutée à `REPAIRABLE_RULES`).
- `check` énumère le contenu réel des répertoires projetés et signale en
  orphelin tout fichier sans source, **sans dépendre** de
  `[projections.hashes]` ; `sync` le supprime.
- Une entrée de `.agents/skills/` qui est un lien symbolique produit une
  violation nommée, jamais un silence ; même traitement pour `.agents/agents/`.
- Un skill `implicit: true` doit déclarer un `allowed-tools` explicite et
  exempt d'outils d'écriture ; l'absence du champ est elle-même une violation.
- Le bloc `rules-index` est comparé octet pour octet au rendu recalculé, et non
  par simple présence des chemins.
- `check` rapporte **toutes** les erreurs de frontmatter d'un `SKILL.md` en une
  passe, et évalue l'identité `name`/dossier avant les contrôles qui en
  dépendent.
- Chaque correction a un test qui échoue quand la vérification est retirée
  (validation par mutation, comme pour l'invariant 14).

## Notes d'implémentation

**Ne pas transformer `check` en `sync` à sec.** `check` reste en lecture seule :
il recalcule en mémoire et compare, il n'écrit jamais. Le plan de `sync` est la
référence, pas son exécution.

**Le point 4 change un comportement existant** : des dépôts qui passaient
peuvent échouer. C'est voulu — le défaut qu'on laisse passer est un skill
implicite capable d'écrire — mais le message doit dire exactement quoi ajouter.

**Le point 2 doit distinguer l'orphelin de l'intrus.** Un fichier sans source
dans une projection est un orphelin à élaguer ; le message doit le dire, et
`sync` doit le supprimer sans détruire ce que l'utilisateur aurait
délibérément rangé là — d'où l'importance de ne signaler que sous les
répertoires réellement projetés.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js sync && node dist/cli.js check
```

Puis, sur un dépôt de démonstration, reproduire les six cas et vérifier que
`check` échoue sur chacun, en nommant le fichier et le correctif.

## Hors périmètre

Les invariants annoncés et jamais implémentés : tâche
[32](32-invariants-promis-non-tenus.md).
