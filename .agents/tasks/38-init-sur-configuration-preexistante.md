# 38 — `init` laisse un dépôt déjà pourvu en `check` rouge, sans prévenir

## Problème

Constat de la validation par un agent réel du 12 septembre 2026
([e2e/validation-agent/rapports/2026-09-12-claude-code.md](../../e2e/validation-agent/rapports/2026-09-12-claude-code.md),
observation 9), sur un clone d'un dépôt réel : 38 skills dans `.agents/skills/`,
`.claude/{rules,skills,agents}` déjà en symlinks, `CLAUDE.md` déjà un lien,
aucun `.agents.toml`.

Ce qui va bien : `init --dry-run` annonce `keep` sur toutes les projections
préexistantes, `init` ne détruit rien, et la découverte par le harness reste
intacte après coup — 96 skills et le sous-agent préexistant toujours vus.

Ce qui ne va pas : `check` sort ensuite **192 violations, code 1**. Le contenu
préexistant ne porte pas le frontmatter étendu qu'exige le contrat
(`display-name`, `short-description`, `color`, `icon`, `default-prompt`), et un
sous-agent au nom capitalisé est refusé par `agent-name-spec`. Or `init` vient
précisément d'écrire `.github/workflows/agents-check.yml`, qui exécute `check` :
le prochain commit casse la CI du dépôt. La sortie d'`init` n'en dit rien — elle
se termine sur « npx agentsdir check — verify the installation (CI runs this) »,
sans laisser prévoir que la vérification échouera de 192 lignes.

L'utilisateur qui essaie agentsdir sur son vrai dépôt le découvre à ce
moment-là. C'est le pire moment.

## Fichiers

- `src/commands/init.ts` — la sortie finale et la décision d'émettre le workflow.
- `src/core/validate.ts` — les règles qui produisent le compte de violations.
- `docs/commandes.md` — la section `init`, comportement sur dépôt pourvu.
- `.agents/tasks/38-init-sur-configuration-preexistante.md` — ce fichier, à
  supprimer à la livraison.

## Critères d'acceptation

- Quand `init` s'installe dans un dépôt dont le contenu préexistant viole le
  contrat, il le dit à la fin de son exécution : combien de violations, sur
  quelles familles de fichiers, et par quelle commande les voir.
- Le message distingue ce qu'`init` a écrit de ce qui préexiste : l'utilisateur
  doit comprendre que les violations portent sur son contenu, pas sur
  l'installation.
- Le comportement par défaut ne change pas : `init` continue d'écrire le
  workflow CI et de ne rien détruire. Aucun contenu utilisateur n'est réécrit
  pour le rendre conforme.
- Un test couvre le cas : dépôt avec un skill non conforme préexistant → `init`
  réussit, et sa sortie annonce les violations à venir.
- `docs/commandes.md` décrit ce comportement dans la section `init`.

## Notes d'implémentation

La validation est déjà écrite : il s'agit de l'exécuter en fin d'`init` et d'en
résumer le résultat, pas d'écrire une seconde règle de vérification. Résumer, ne
pas déverser les 192 lignes : un compte, les familles concernées, la commande
qui détaille.

Ne pas proposer de réparation automatique du contenu préexistant : c'est le
métier de `migrate`, différé, et la limite doit rester nette.

## Vérification

```bash
npm run build && npm test
```

Puis le terrain 2 du scénario
[e2e/validation-agent/prompt.md](../../e2e/validation-agent/prompt.md) : sur un
clone d'un dépôt réel déjà pourvu, la sortie d'`init` doit annoncer le nombre de
violations que `check` va rapporter.

## Hors périmètre

Assouplir le contrat pour accepter le contenu existant, ou le réécrire pour le
rendre conforme. Les deux sont des décisions de produit qui appartiennent à
`migrate`, pas à cette tâche.
