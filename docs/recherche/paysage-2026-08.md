# Paysage concurrentiel — relevé du 30 août 2026

Mise à jour de [paysage-open-source.md](paysage-open-source.md), qui datait de la
conception. Le terrain a changé : ce document consigne ce qui est vérifié, pour
que les décisions produit s'appuient sur des faits datés plutôt que sur
l'intuition de départ.

Chaque affirmation est vérifiée à la source citée, sauf mention contraire.

## Les trois concurrents qui comptent

| Outil | Étoiles | Dernier push | Ce qu'il fait qu'agentsdir ne fait pas |
| --- | --- | --- | --- |
| [ruler](https://github.com/intellectronica/ruler) | 2 900 | 2026-08-26 | 32 harness ; **propagation MCP** ; `revert` avec sauvegardes ; règles imbriquées |
| [rulesync](https://github.com/dyoshikawa/rulesync) | 1 362 | 2026-08-30 | 40+ outils × 9 dimensions dont MCP, hooks, permissions ; **`import`** (= notre `migrate`) ; **`fetch owner/repo`** (= notre `vendor`) |
| [vercel-labs/skills](https://github.com/vercel-labs/skills) | 30 000 | 2026-08-18 | 77 agents ; `add` depuis GitHub/GitLab/URL **y compris dépôts privés** ; `skills-lock.json` avec empreinte de dossier ; `update`/`check`/`find` |

La longue traîne est saturée : au moins onze outils sous 150 étoiles portent la
même promesse. Le plus proche de notre architecture,
[agent-sync](https://github.com/IngSquared99/agent-sync) (`.agents/` +
`AGENTS.md` + symlinks, Go), a été créé le 29 août 2026.

**Conséquence directe : deux fonctionnalités de notre roadmap sont déjà
livrées ailleurs.** `vendor` existe sous le nom `npx skills add owner/repo`,
verrouillage par empreinte compris. `migrate` existe sous le nom
`rulesync import`. Les inscrire au backlog revient à courir derrière, pas à se
distinguer.

## L'état des standards

- **AGENTS.md** est passé à l'Agentic AI Foundation (Linux Foundation) le
  9 décembre 2025, avec MCP et goose. Point à connaître :
  [agents.md](https://agents.md/) déclare qu'il n'existe **aucune spécification
  formelle** — « just standard Markdown », pas de frontmatter, pas de version.
  La seule règle structurante est l'imbrication : le fichier le plus proche
  l'emporte.
- **Agent Skills** a, lui, une spécification formelle
  ([agentskills.io/specification](https://agentskills.io/specification)) et
  surtout un **validateur de référence** : `skills-ref validate ./my-skill`.
  Nos invariants de `check` devraient s'y aligner explicitement plutôt que de
  redéfinir les mêmes contraintes dans leur coin.
- **MCP** en est à la révision du 28 juillet 2026, avec des extensions
  négociées à l'initialisation — dont un groupe de travail « Skills over MCP »
  qui rendrait les skills découvrables *via* MCP. À surveiller : cela toucherait
  directement notre objet.

## Ce que demandent les utilisateurs

Le signal se concentre sur `vercel-labs/skills` ; les trackers de ruler et
rulesync sont quasi vides, ce qui est en soi un renseignement sur leur usage
réel.

1. **Installation reproductible depuis un lockfile** — la demande la plus forte
   du corpus : huit issues convergentes, environ 250 réactions cumulées, dont
   une intitulée « équivalent `npm ci` ». Nous avons déjà `skills-lock.json` et
   l'empreinte ; il manque la commande qui l'exploite.
2. **Sources privées** — l'issue la plus soutenue du dépôt (78 réactions).
3. **`.agents/` est validé comme convention** — « l'emplacement commun compris
   par presque tous les outils agentiques modernes » — et **les symlinks cassent
   pour de vrai** : quatre issues distinctes. Notre repli en mode copie répond à
   un problème documenté, pas à une précaution théorique.
4. **Prolifération des skills** — « nous sommes passés de 67 à 183 skills en
   moins d'un mois » : bloat, redondance, pression sur la fenêtre de contexte.
5. **Le contenu ne déclenche pas.** Plusieurs issues très soutenues sur Claude
   Code, et sur Hacker News « AGENTS.md outperforms skills in our agent evals »
   (524 points), « Your AGENTS.md file doesn't do anything ». Le doute porte sur
   l'utilité même de ce que ces outils installent.
6. **Élagage de la dérive** — rulesync a une issue ouverte : sa génération de
   skills « n'élague jamais les fichiers qu'un dossier ne possède plus ». Notre
   couple `check`/`sync` traite un problème que les concurrents n'ont pas résolu.

## Sur l'audit d'invocation

La demande est attestée : une issue Claude Code « Skill invocation tracking and
usage analytics » (43 réactions) décrit exactement un journal local, une
commande de statistiques et le repérage des skills jamais invoqués. Faute de
réponse native, la communauté a bricolé — [deadskills](https://github.com/anandsaini18/deadskills)
parse les transcripts, et des piles OpenTelemetry maison circulent.

L'issue a été fermée comme résolue le 17 août 2026 par un mainteneur, au motif
qu'un événement de télémétrie serait émis à chaque activation. **La
documentation officielle consultée ne mentionne pas cet événement** : les skills
n'y apparaissent que comme attribut, et les hooks seulement en traces bêta
derrière deux variables d'environnement. Cet écart entre la parole et la
documentation illustre le besoin plutôt qu'il ne le clôt.

**Ce qu'aucune source ne montre existant : un audit local au dépôt, agnostique
du harness, qui rattache les invocations observées à la source de vérité
`.agents/`.** deadskills couvre deux harness et raisonne par transcripts
utilisateur ; OpenTelemetry est spécifique à Claude Code. L'angle est libre, et
c'est le seul de cette liste qui le soit.

## Ce que ce relevé implique

La course au nombre de harness est perdue d'avance — trois contre trente-deux,
quarante et soixante-dix-sept — et ce n'est pas grave : ce n'est pas là que se
joue la valeur. Ce qui nous appartient en propre, et que le relevé confirme :

- **la vérification de dérive** (`check`/`sync`), que les concurrents n'ont pas
  résolue ;
- **les hooks portables multi-harness**, qu'aucun n'installe ;
- **l'audit d'usage** qui en découle, dont l'angle repo-local est inoccupé.

Les trois se tiennent et racontent une seule chose : la configuration d'agents
qui se vérifie, et qui prouve qu'elle sert. C'est une position défendable ; le
nombre de harness ne l'est pas.
