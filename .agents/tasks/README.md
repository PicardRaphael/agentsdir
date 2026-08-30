# Tâches

Une tâche différée par fichier. Chaque fichier est auto-suffisant : il énonce le problème, les fichiers concernés, les critères d'acceptation et la vérification.

Prendre les tâches dans l'ordre du plan ([`../plan/v1.md`](../plan/v1.md)) sauf mention `Dépend de :` contraire. Le plan v1 est clos ; les tâches 17 et suivantes sont indépendantes entre elles et peuvent être prises dans n'importe quel ordre.

## Conventions

- Nom de fichier : `NN-titre-en-kebab.md` (numéro sur deux chiffres).
- Sections dans l'ordre : Problème → Fichiers → Critères d'acceptation → Notes d'implémentation → Vérification → Hors périmètre.
- Toute référence `fichier:ligne` doit être valide au moment du commit.
- Supprimer le fichier une fois la tâche livrée : un fichier de tâche résolu qui traîne se lit comme du travail ouvert.

## Déléguer

```
Agent (subagent_type: general-purpose)
Prompt : « Implémente .agents/tasks/<fichier>. Respecte exactement les critères
d'acceptation. Exécute la section Vérification et colle sa sortie avant de
conclure. »
```
