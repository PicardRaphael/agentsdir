# Validation par un agent réel — scénario reproductible

Troisième tier de test, manuel et assumé comme tel (voir [TESTING.md](../../TESTING.md)).
À dérouler après une release, ou après tout changement touchant les projections,
le frontmatter, les hooks ou les templates des générateurs.

Ce que ce tier prouve et que les deux autres ne peuvent pas prouver : **qu'un
harness charge réellement ce que la CLI écrit**. `check` compare des octets à un
rendu attendu ; il ne dit pas qu'un skill est découvert, qu'un sous-agent est
proposé, qu'un hook se déclenche, ni qu'`AGENTS.md` est lu. L'écart est celui
entre « le fichier est correct » et « le fichier sert ».

Durée : environ trente minutes, deux terrains compris.

## Ce dont on a besoin

- la CLI construite : `npm run build` à la racine d'agentsdir ;
- le harness installé sur la machine (v1 : Claude Code, `claude --version`) ;
- un répertoire jetable hors du dépôt pour les terrains ;
- de quoi consigner : le compte rendu se range dans
  [`rapports/`](rapports/), nommé `AAAA-MM-JJ-<harness>.md`.

## Pièges de mise en œuvre, à connaître avant de commencer

Ils ne concernent pas le produit : ils concernent la façon de conduire l'agent.
Les ignorer produit de faux verdicts.

- **Sous-session lancée depuis une session du harness** : `unset CLAUDECODE`
  avant l'appel, sinon l'imbrication est détectée.
- **Git Bash réécrit les arguments commençant par `/`** : `/demo-flow` arrive
  au harness sous la forme `C:/Program Files/Git/demo-flow`. Préfixer par
  `MSYS_NO_PATHCONV=1`, ou lancer la commande depuis PowerShell.
- **stdin** : ajouter `< /dev/null`, sinon le harness attend trois secondes une
  entrée qui ne vient pas.
- **`--tools ""` ne retire que les outils intégrés** : les serveurs MCP et les
  outils serveur de la configuration utilisateur restent disponibles. Une sonde
  « sans aucun outil » n'est donc jamais tout à fait hermétique — le dire dans
  le compte rendu plutôt que de prétendre l'inverse.
- **L'environnement n'est pas vierge** : la configuration utilisateur
  (`~/.claude/`) est chargée en plus de celle du dépôt. Ne juger que ce qui
  porte les noms créés pour l'occasion (`demo-flow`, `demo-reviewer`).
- **Coût** : les sondes tournent très bien sur un modèle rapide
  (`--model sonnet`). La même sonde sur le modèle par défaut a coûté quarante
  fois plus cher pour le même verdict.

## La sonde canonique : le message `system/init`

La preuve la moins chère et la plus dure ne demande aucune prose au modèle. En
sortie `stream-json`, le premier message d'une session énumère les skills
découverts et les sous-agents délégables :

```bash
claude -p "ok" --model sonnet --output-format stream-json --verbose --tools "" < /dev/null > init.jsonl
node -e 'const o=require("fs").readFileSync("init.jsonl","utf8").split("\n").map(l=>{try{return JSON.parse(l)}catch{return{}}}).find(x=>x.type==="system"&&x.subtype==="init"); console.log(JSON.stringify({slash:o.slash_commands,agents:o.agents},null,2))'
```

Un nom attendu qui manque dans `slash_commands` ou dans `agents` est un verdict
« infirmé », sans interprétation possible. Un nom présent ne dit pas encore que
son frontmatter est lu : c'est l'objet des observations 3 et 4.

## Terrain 1 — dépôt neuf (reproductibilité)

### Montage

```bash
mkdir terrain-neuf && cd terrain-neuf
git init -q . && git config user.email demo@example.com && git config user.name Demo
printf '{ "name": "demo-neuf", "private": true }\n' > package.json

CLI=<chemin>/agentsdir/dist/cli.js
node $CLI init --yes --name "demo-neuf" \
  --dev "npm run zorglub:dev" --test "npm run zorglub:test" --lint "npm run zorglub:lint"
node $CLI add skill demo-flow
node $CLI add agent demo-reviewer
node $CLI add hook PreToolUse
node $CLI check
```

Les commandes portent volontairement un nom que rien ne peut deviner
(`zorglub`) : c'est ce qui permet de distinguer, à l'observation 5, un agent qui
a lu le dépôt d'un agent qui a deviné.

**Conserver la sortie de chaque commande** : elle est la pièce à conviction de
l'observation 6.

Le hook généré est un squelette qui laisse passer. Pour l'observation 4,
remplacer son bloc `TODO` par une décision réelle :

```js
const command = payload?.tool_input?.command ?? "";
if (command.includes("forbidden")) {
  console.error("blocked by the demo PreToolUse hook: command contains forbidden");
  process.exit(2);
}
```

`check` doit rester vert après cette édition : le contenu du hook appartient à
l'utilisateur.

### Les six observations

| # | Observation | Sonde | Attendu |
| --- | --- | --- | --- |
| 1 | Le skill créé est découvert | `system/init` ; puis `MSYS_NO_PATHCONV=1 claude -p "/demo-flow" --tools ""` | `demo-flow` dans `slash_commands` ; l'invocation injecte le contenu du `SKILL.md` (le vérifier en demandant à l'agent de citer une phrase du corps) |
| 2 | Le sous-agent est proposé à la délégation | `system/init` | `demo-reviewer` dans `agents` |
| 3 | Le frontmatter du skill est réellement lu | `claude -p "Sans utiliser aucun outil : le skill demo-flow figure-t-il dans la liste des skills disponibles fournie par ton contexte ? Si oui cite sa description mot pour mot, sinon dis ABSENT." --tools ""` | avec `disable-model-invocation: true`, la réponse attendue est `ABSENT` : le skill reste invocable par `/demo-flow` mais n'est pas injecté. Une description qui serait le commentaire `GENERATED by agentsdir` signifie que le frontmatter n'est pas parsé |
| 4 | Le hook se déclenche et son `exit 2` bloque | `claude -p "Execute avec l'outil Bash exactement cette commande: echo forbidden-demo" --include-hook-events --tools "Bash" --allowedTools "Bash" --permission-prompts none` | un `hook_response` avec `exit_code: 2`, puis un `tool_result` en erreur : la commande n'a pas été exécutée |
| 5 | `AGENTS.md` et l'index des règles sont lus | `claude -p "Sans utiliser aucun outil, reponds en deux lignes: 1) la commande de test de ce depot, telle quelle; 2) le nom du fichier de regle a lire avant de toucher .agents/tasks/." --tools ""` | `npm run zorglub:test` et `.agents/rules/tasks.md`, sans le moindre appel d'outil |
| 6 | La collecte d'usage enregistre ce qu'un harness envoie vraiment | `node $CLI pack add usage` puis une session qui lit un fichier et délègue à un sous-agent ; lire ensuite `.agents/output/usage/usage-*.jsonl` | une ligne par événement, avec le bon `tool`, un `path` relatif, et surtout un `agent` renseigné sur `SubagentStart`/`SubagentStop` — c'est le point non confirmé de `docs/conventions.md` §9 : si `agent` est `null`, les clés acceptées par le collecteur ne sont pas celles que le harness envoie, et il faut les corriger |
| 7 | Les messages de la CLI suffisent | coller les sorties conservées à une session sans dépôt ni documentation (`--tools ""`) et lui demander, pour chaque commande, si elle sait quoi faire ensuite et ce qui lui manque | une étape suivante identifiable après chaque commande |

### Les deux modes de projection

`init` détecte le mode : sur une machine où les symlinks fonctionnent, c'est le
mode symlink. **Les deux modes doivent être passés** — c'est en mode copie que
le contenu est réécrit, donc là que le harness peut cesser de le comprendre.
Refaire le terrain avec `init --yes --mode copy` et rejouer au minimum les
observations 1, 2 et 3. Le compte rendu dit quel mode a été détecté et lequel a
été forcé.

## Terrain 2 — dépôt réel déjà pourvu (le cas non couvert)

Un dépôt neuf ne dit rien de ce qui arrive quand `init` rencontre une
configuration existante — `.agents/` déjà peuplé, `.claude/` déjà en place,
`CLAUDE.md` déjà présent. C'est aussi la répétition générale de `migrate`.

**Travailler sur un clone, jamais sur le dépôt lui-même** (`git clone --depth 1`
d'un chemin local suffit, et n'emporte pas les fichiers non versionnés).

```bash
node $CLI doctor              # avant : ce que la CLI voit d'une config non initialisee
node $CLI init --yes --dry-run  # le plan, d'abord : rien ne doit etre detruit
node $CLI init --yes
node $CLI check               # combien de violations, et lesquelles
```

Observations propres à ce terrain :

- `init` préserve-t-il les projections existantes (`keep`) plutôt que de les
  écraser ;
- le contenu préexistant passe-t-il le contrat (`check`) — sinon, combien de
  violations, et l'utilisateur en a-t-il été averti au moment d'`init` ;
- le harness découvre-t-il toujours l'existant **et** ce que `init` a ajouté
  (sonde `system/init`).

## Hors de portée d'une validation par agent

À noter comme tel, jamais à déclarer validé :

- **l'affichage de l'icône et de la couleur dans Codex** : c'est visuel, aucun
  agent ne peut l'observer. Seul un examen humain de l'interface le peut ;
- **le déclenchement des hooks dans Codex et Cursor** : le scénario ci-dessus ne
  couvre que Claude Code. Le critère de sortie v0.4 (« un hook créé une fois se
  déclenche dans les trois harnesses ») reste non vérifié pour deux tiers.

## Consigner

Le compte rendu reprend la grille : observation, attendu, constaté, verdict
(**vérifié**, **infirmé**, **hors de portée**), preuve. Il mentionne la date, la
version du harness, le modèle, le mode de projection, et la commande exacte de
chaque sonde.

**Un écart constaté devient une tâche de `.agents/tasks/` ou un correctif dans
le même commit.** Une validation dont le résultat ne change rien n'a pas de
valeur.
