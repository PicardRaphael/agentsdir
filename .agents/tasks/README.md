# Tâches

Une tâche différée par fichier. Chaque fichier est auto-suffisant : il énonce le problème, les fichiers concernés, les critères d'acceptation et la vérification.

Le plan v1 ([`../plan/v1.md`](../plan/v1.md)) est clos ; il n'est conservé que comme trace des dépendances entre tâches livrées.

**L'ordre de prise est celui de [`docs/positionnement.md`](../../docs/positionnement.md), pas l'ordre des numéros** — un numéro dit quand la tâche a été écrite, pas quand elle doit être prise. Ordre arrêté le 30 août 2026 : **26 → 24 → 25 → 28 → 30 → 27** ; la 26 et la 24 sont livrées le 12 septembre 2026, la suivante est donc la 25. Les tâches 17 à 23 (dette technique), 37 et 38 (validation par un agent réel du 12 septembre 2026) se traitent en parallèle, sans bloquer cette ligne. Respecter les mentions `Dépend de :` quand elles existent.

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
