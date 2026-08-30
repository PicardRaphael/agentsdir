# 28 — Ce que la configuration coûte en contexte

## Problème

Tout ce que ce produit installe est payé, à chaque session, en fenêtre de
contexte. Les métadonnées de chaque skill sont chargées au démarrage ;
`AGENTS.md` est lu en entier ; une règle indexée est injectée dès qu'elle est
pertinente. Personne ne sait combien cela fait, ni quel élément pèse le plus.

Le terrain le confirme (voir
[docs/recherche/paysage-2026-08.md](../../docs/recherche/paysage-2026-08.md)) :
« nous sommes passés de 67 à 183 skills en moins d'un mois », avec bloat,
redondance et pression sur la fenêtre de contexte parmi les plaintes les mieux
soutenues. La spécification Agent Skills énonce d'ailleurs des budgets —
métadonnées de l'ordre de la centaine de tokens au démarrage, corps sous les
5 000 tokens, `SKILL.md` sous 500 lignes — que rien ne vérifie aujourd'hui.

Cette tâche est le pendant de la [25](25-pack-usage-boucle-de-retroaction.md).
L'usage dit **si** un élément sert ; le coût dit **combien** il coûte. Les deux
ensemble donnent la seule question qui compte pour une équipe : ce skill vaut-il
ce qu'il coûte ? Un skill jamais invoqué qui pèse 4 000 tokens au démarrage est
un candidat évident à la suppression ; le même à 80 tokens ne mérite pas qu'on
en parle.

Aucun outil comparable ne mesure cela.

## Fichiers

- `src/core/validate.ts` — les invariants ; c'est là que les bornes de la spec
  Agent Skills trouveraient leur place.
- `src/commands/doctor.ts` — le lieu naturel d'un rapport de diagnostic.
- `src/core/frontmatter.ts` — les champs chargés au démarrage contre ceux qui ne
  le sont qu'à l'invocation : la distinction structure toute la mesure.
- `docs/conventions.md` — les bornes documentées, à aligner sur la spec.

## Notes d'implémentation

**Le point de conception à trancher : comment compter sans dépendance.** Un
comptage exact suppose le tokenizer du modèle visé, donc une dépendance lourde —
et le projet en limite le nombre à quatre, chacune justifiée par écrit. Deux
issues honnêtes :

- annoncer une **estimation** (rapport caractères/tokens documenté, calibré une
  fois sur un échantillon réel) et le dire dans le rapport, sans jamais afficher
  un nombre qui laisserait croire à une mesure exacte ;
- ou compter en octets et en lignes, unités exactes, en laissant la conversion
  au lecteur.

La première est plus utile si l'approximation est assumée ; la seconde est
irréprochable mais moins parlante. Trancher explicitement, et écrire le choix
dans `docs/conventions.md` — ne pas laisser un chiffre sans nature.

**Distinguer ce qui est payé toujours de ce qui est payé parfois.** C'est la
distinction la plus importante du rapport, et la plus facile à rater :

- payé à **chaque** session : `AGENTS.md` entier, les métadonnées de tous les
  skills, l'index des règles ;
- payé à l'**invocation** : le corps d'un skill, ses `references/` ;
- payé **si pertinent** : une règle dont le périmètre recoupe les fichiers
  touchés.

Un rapport qui additionne tout donne un chiffre impressionnant et faux.

**Ne pas transformer la mesure en règle bloquante.** Un dépassement de budget
est une information, pas une violation d'invariant : `check` doit rester le
gardien de la dérive, pas de la sobriété. Le rapport va dans `doctor`, dont la
promesse est justement de diagnostiquer sans faire échouer.

## Critères d'acceptation

- Un rapport donne, par élément installé, ce qu'il pèse et à quel moment il est
  payé — toujours, à l'invocation, ou selon pertinence.
- La nature du chiffre est explicite : estimation calibrée ou unité exacte,
  jamais un nombre dont on ignore ce qu'il mesure.
- Le total « payé à chaque session » est distingué du total général.
- Les bornes de la spécification Agent Skills (longueur de la description,
  taille du corps) sont vérifiées et signalées quand elles sont dépassées.
- Un dépassement informe, il ne fait pas échouer `check`.
- Le rapport se lit dans le terminal, et sa version machine (`--json`) permet
  d'en faire un suivi dans le temps.
- Le coût de la mesure elle-même est négligeable sur un dépôt à 60 skills.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js check && node dist/cli.js doctor
```

Puis, sur un dépôt de démonstration portant des skills de tailles très
différentes : vérifier que le classement correspond à la réalité, que la
distinction « toujours / à l'invocation » est juste, et qu'un `SKILL.md`
volontairement trop long est signalé.

## Hors périmètre

- Optimiser automatiquement le contenu : l'outil mesure et signale, l'utilisateur
  et son agent décident.
- Un tokenizer embarqué : la contrainte des quatre dépendances tient, et une
  estimation assumée vaut mieux qu'une dépendance de plusieurs mégaoctets.
- Comparer le coût entre harness : chacun charge le contexte à sa façon, et rien
  ne permet aujourd'hui de mesurer cela de l'extérieur de façon fiable.
