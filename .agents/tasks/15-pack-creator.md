# 15 — Pack `creator` (méta-skills de création assistée)

Dépend de : 09, 10

## Problème

Les générateurs de l'étage 1 produisent des squelettes corrects, pas du contenu parfait. Le pack `creator` installe les méta-skills qui guident l'agent du harness pour créer chaque artefact par interview, selon le protocole de [docs/creation-assistee.md](../../docs/creation-assistee.md).

## Fichiers

- `src/packs/creator/skills/create-skill/` — SKILL.md + `references/rubrique.md` + `references/interview.md`
- `src/packs/creator/skills/create-hook/` — idem
- `src/packs/creator/skills/create-rule/` — idem
- `src/packs/creator/skills/create-agent/` — idem
- Branchement dans `init` (coché par défaut) et `pack add creator`

## Critères d'acceptation

- Chaque méta-skill applique le protocole en six temps : inventaire → interview ciblée (banque de questions de `references/interview.md`) → aiguillage (règle / skill / hook / sous-agent) → brouillon + critique (question-filtre : « si on supprime cette ligne, l'agent fera-t-il une erreur ? ») → `agentsdir add …` puis rédaction du contenu → `agentsdir check` obligatoire avant de conclure.
- Les rubriques de qualité de `docs/creation-assistee.md` sont embarquées dans `references/rubrique.md` de chaque méta-skill, critères ▣ (mécaniques) distingués des critères de critique.
- `$create-skill` impose le test de déclenchement : ≥ 3 phrases qui doivent déclencher, ≥ 2 proches qui ne doivent pas ; la description générée est en troisième personne avec les mots-clés de l'utilisateur.
- `$create-hook` pose les questions d'aiguillage (empêcher → événement bloquant + exit 2 ; réagir → PostToolUse), demande fail-open/fail-closed, refuse de créer un hook pour une interdiction de sécurité dure (oriente vers les permissions du harness).
- Les méta-skills respectent elles-mêmes toutes les conventions : `disable-model-invocation: true`, corps < 500 lignes, renvois à un seul niveau, projections Codex générées.
- Chaque contenu du pack est enregistré dans `skills-lock.json` avec `sourceType: "agentsdir"` et son empreinte (protection `update`).
- Test d'intégration : sur un repo de démonstration, dérouler `$create-skill` en réponses scriptées produit un skill qui passe `check` du premier coup.

## Notes d'implémentation

La matière première (pratiques sourcées, anti-patterns, protocoles skill-creator et « Claude A/B ») est dans le rapport de recherche résumé par `docs/creation-assistee.md` — s'y conformer, ne pas réinventer. Les méta-skills sont rédigées en anglais (contenu produit, pas doc de conception).

## Vérification

```bash
npm test -- pack-creator
```

## Hors périmètre

`$setup-context` (tâche 16) ; l'évaluation automatisée des skills créés (post-v1).
