# 32 — Les invariants que `check` promet et ne vérifie pas

## Problème

[`docs/conventions.md`](../../docs/conventions.md) ouvre sa section 4 par
« **The invariants validated by `check`** », annonce une « Exhaustive list » et
en énumère seize. **Trois ne sont pas implémentés, et un quatrième contrat n'est
pas tenu.**

C'est le pire endroit possible pour un écart. Ce document est le contrat que le
produit installe dans les dépôts de ses utilisateurs, et la thèse du produit est
précisément qu'une configuration se vérifie. Un vérificateur qui promet seize
garanties et en tient treize ruine l'argument qu'il porte.

### Ce qui manque, vérifié

**Invariant 14 — frontmatter des sous-agents.** `docs/conventions.md:110`
garantit que tout `.agents/agents/*.md` porte un `name` et une `description` non
vides, et qualifie ce défaut de « most insidious » puisqu'un fichier mal formé
est *silencieusement ignoré* par Claude Code. `src/core/validate.ts` n'énumère
jamais `.agents/agents/` — les seules occurrences de ce chemin visent
`.agents/skills/` et `.agents/rules/` — et n'émet aucune règle correspondante.

**Invariant 15 — protocole des scripts de hook.** `docs/conventions.md:111`
garantit que tout script de `.agents/hooks/` peut être invoqué à vide avec un
JSON d'exemple sur stdin, et respecte le protocole (stdout vide ou commençant
par `{`, code de sortie documenté). Rien dans `validate.ts` n'exécute quoi que
ce soit : seul `validateHookRegistries` existe, et il porte l'invariant 16, qui
est autre chose — la forme du registre, pas le comportement du script.

**Invariant 11 — santé des liens symboliques, à moitié.**
`docs/conventions.md:107` le confie à `check`. La détection existe bien
(`src/core/detect.ts:191`, lecture du mode git `120000`) mais n'est consommée
que par `src/commands/doctor.ts:199`. `check` ne couvre que la moitié « présent
sur le disque ». Le code lui-même acte l'intention non tenue :
`src/core/detect.ts:64` décrit cette dérive comme « the drift **`check`** must
[detect] ».

**Portée du verrou.** `docs/conventions.md:178` et
`docs/creation-assistee.md:105` annoncent une entrée `sourceType: "agentsdir"`
pour « les règles génériques et les templates ». `src/packs/index.ts` ne produit
que des entrées de skills, et `skills-lock.json` ne contient que les méta-skills
du pack `creator`. Les règles génériques et les templates ne sont donc suivis
par rien.

## Fichiers

- `src/core/validate.ts` — les trois invariants à implémenter.
- `src/core/detect.ts:191` — la détection de symlinks, à consommer aussi depuis
  `check`.
- `src/commands/doctor.ts:199` — le diagnostic existant, à conserver : `doctor`
  explique, `check` échoue.
- `src/packs/index.ts` — la portée du verrou à étendre.
- `docs/conventions.md` — à mettre en accord avec le code livré.

## Critères d'acceptation

- `check` échoue sur un `.agents/agents/*.md` dépourvu de `name` ou de
  `description`, ou dont le `name` n'est pas en minuscules et tirets, avec un
  message qui nomme le fichier et le champ fautif.
- `check` vérifie le protocole des scripts de `.agents/hooks/` : invocation à
  vide avec un JSON d'exemple sur stdin, stdout vide ou commençant par `{`, code
  de sortie documenté.
- L'exécution d'un script de hook par `check` est **bornée** — délai maximal,
  pas d'entrée interactive — et un script qui dépasse ce délai produit une
  violation nommée, jamais un blocage.
- `check` signale les projections indexées en mode git `120000` mais
  matérialisées en fichiers texte, en réutilisant `detect.ts` sans dupliquer sa
  logique ; `doctor` conserve son diagnostic explicatif.
- Le verrou couvre les règles génériques et les templates installés par la CLI,
  conformément à `docs/conventions.md:178`, ou bien ce contrat est corrigé si la
  couverture est jugée inutile — dans les deux cas, le document et le code
  disent la même chose.
- Chaque invariant nouvellement implémenté a un test qui échoue quand la
  vérification est retirée — vérifié par mutation, pas seulement par un cas
  passant.
- La liste de `docs/conventions.md` est réputée exacte à la livraison : chaque
  invariant annoncé est implémenté, ou retiré de la liste.

## Notes d'implémentation

**Exécuter un script tiers pendant `check` est le point délicat.** `check` est
lancé en CI, en lecture seule, et doit rester rapide et sûr. Le script exécuté
appartient au dépôt vérifié, donc à l'utilisateur — ce n'est pas du code
distant. Il faut néanmoins un délai maximal, stdin fermé après l'envoi du JSON
d'exemple, et aucune variable d'environnement supplémentaire. Si ce coût est
jugé trop élevé pour la CI, l'alternative honnête est de **déplacer l'invariant
15 vers `doctor`** et de corriger `docs/conventions.md` en conséquence — mais
pas de laisser la promesse là où elle est.

**Ne pas dupliquer la détection de symlinks.** `detect.ts` la porte déjà ;
`check` la consomme, comme `doctor` le fait. La duplication de sondes est
précisément ce que l'audit d'architecture a supprimé (`core/fs-utils.ts`).

**Le déterminisme reste le contrat.** Après ces ajouts,
`node dist/cli.js sync` doit toujours répondre « 0 created, 0 updated » sur ce
dépôt.

## Vérification

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm run test:e2e
node dist/cli.js sync && node dist/cli.js check
```

Puis, sur un dépôt de démonstration : créer un sous-agent sans `description` et
vérifier que `check` échoue en le nommant ; créer un script de hook qui écrit du
texte libre sur stdout et vérifier qu'il est signalé ; créer un script qui ne
rend jamais la main et vérifier que `check` le borne au lieu de se bloquer ;
matérialiser une projection indexée en `120000` et vérifier que `check` la
signale.

## Hors périmètre

- Les autres écarts entre documentation et code, qui relèvent de la tâche
  [33](33-coherence-documentaire.md).
- La commande `update`, qui est la tâche [31](31-commande-update.md).
