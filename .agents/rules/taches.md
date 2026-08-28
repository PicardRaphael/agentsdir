# Exécution des tâches

À lire avant de prendre toute tâche de `.agents/tasks/`.

## Règles

- Prendre les tâches dans l'ordre de `.agents/plan/v1.md` sauf mention `Dépend de :` contraire.
- Respecter les critères d'acceptation **exactement** — ni plus (pas d'élargissement de périmètre), ni moins.
- Exécuter la section Vérification de la tâche et coller sa sortie avant de conclure. Sans sortie collée, la tâche n'est pas livrée.
- Appliquer la Definition of Done d'`AGENTS.md` : critères satisfaits, vérification exécutée, typecheck/lint/tests verts, docs impactées à jour dans le même commit.
- **Supprimer le fichier de la tâche** une fois livrée — un fichier de tâche résolu qui traîne se lit comme du travail ouvert.
- Ne jamais rouvrir une décision actée (`docs/SPEC.md`, tableau des décisions) sans demande explicite de l'utilisateur.
- Si un critère se révèle impossible ou contradictoire pendant l'implémentation : s'arrêter, documenter le conflit, demander — ne pas improviser une variante silencieuse.
