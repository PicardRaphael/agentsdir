# 37 — Les générateurs ne disent pas ce qu'il reste à faire

## Problème

Constat de la validation par un agent réel du 12 septembre 2026
([e2e/validation-agent/rapports/2026-09-12-claude-code.md](../../e2e/validation-agent/rapports/2026-09-12-claude-code.md),
observation 6). Les sorties de `add skill`, `add agent` et `add hook` ont été
soumises telles quelles à un agent sans dépôt ni documentation. Réponse : il ne
sait quoi faire ensuite après aucune des trois.

`init` s'en tire, lui, parce qu'il imprime des « Next steps ». Les générateurs
listent les fichiers créés et s'arrêtent là :

```
$ npx agentsdir add skill demo-flow
stdin is not a TTY — using template defaults.
Done:
  created  .agents/skills/demo-flow/SKILL.md
  created  .agents/skills/demo-flow/agents/openai.yaml
  created  .agents/skills/demo-flow/assets/icon.svg
```

Ce qui manque, dans l'ordre de gravité rapporté par l'agent :

- l'étape suivante — le fichier créé est un squelette à remplir, rien ne le dit,
  et rien ne dit comment l'invoquer une fois rempli (`/demo-flow`) ;
- pour `add hook`, la nature de l'écriture : trois fichiers de configuration
  partagés avec l'utilisateur (`.claude/settings.json`, `.codex/hooks.json`,
  `.cursor/hooks.json`) sont tous annoncés « created », sans distinguer une
  création d'une fusion dans un fichier préexistant, et sans dire que le corps
  du hook est un `TODO` qui ne bloque rien tant qu'il n'est pas écrit ;
- `stdin is not a TTY — using template defaults.` constate un repli sans nommer
  le moyen d'y échapper : les options qui donnent de vraies réponses.

Le contrat « répondre sans terminal » de [docs/commandes.md](../../docs/commandes.md)
dit que toute question d'interview a son option. Le message qui annonce le repli
est justement l'endroit où le rappeler.

## Fichiers

- `src/commands/add-common.ts` — `runGeneratorCli`, la sortie partagée des
  quatre générateurs : c'est là que se décide la forme, pas dans chacun.
- `src/commands/add-skill.ts`, `add-agent.ts`, `add-rule.ts`, `add-hook.ts` —
  ce que chacun a de spécifique à dire.
- `src/commands/init.ts` — la forme « Next steps » à reprendre, pas à réinventer.
- `docs/commandes.md` — la sortie attendue de chaque générateur.
- `.agents/tasks/37-messages-des-generateurs.md` — ce fichier, à supprimer à la
  livraison.

## Critères d'acceptation

- Chaque générateur termine par une étape suivante nommée : ce qu'il reste à
  écrire dans le fichier créé, et la commande qui vérifie (`check`).
- `add skill` nomme la façon d'invoquer le skill créé dans un harness.
- `add hook` distingue, par fichier touché, une création d'une mise à jour d'un
  fichier préexistant, et signale que le corps du hook est un squelette qui ne
  décide rien tant qu'il n'est pas complété.
- Le message de repli sans terminal nomme au moins une option permettant de
  répondre vraiment.
- Les messages restent en anglais, et `--json` n'est pas modifié : ce qui change
  est la sortie humaine.
- Un test par générateur vérifie la présence de l'étape suivante dans la sortie.

## Notes d'implémentation

Ne pas transformer la sortie en documentation : deux à quatre lignes, sur le
modèle d'`init`. Le critère est qu'un agent ou un humain sache quoi faire sans
ouvrir `docs/`, pas qu'il ait tout lu.

## Vérification

```bash
npm run build
node dist/cli.js add skill demo-flow    # dans un dépôt jetable initialisé
node dist/cli.js add hook PreToolUse
npm test
```

Puis rejouer l'observation 6 du scénario
[e2e/validation-agent/prompt.md](../../e2e/validation-agent/prompt.md) : la
même question posée à une session sans dépôt ni documentation doit désormais
recevoir un « oui » pour chaque commande.

## Hors périmètre

Refondre l'interview elle-même, ou ajouter des options nouvelles : il s'agit de
nommer celles qui existent.
