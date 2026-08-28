# Documentation

À lire avant de modifier tout fichier `*.md` du repo.

## Règles

- **Français** pendant la phase de conception, orthographe et accents irréprochables ; identifiants techniques (fichiers, commandes, champs, événements) en anglais. La doc publique passe en anglais à la release (tâche 14).
- **Terminologie canonique**, à employer telle quelle : « source de vérité », « projection », « mode symlink / mode copie (repli) », « blocs gérés », « manifeste `.agents.toml` », « harness ».
- **`docs/architecture.md` fait foi** en cas de conflit entre documents ; la correction se propage aux autres dans le même commit.
- Diagrammes en Mermaid dans les `.md` versionnés ; sauts de ligne d'étiquette en `<br/>`, jamais `\n` ; identifiants de nœuds sans accents ni espaces.
- Liens relatifs corrects depuis l'emplacement du fichier source ; vérifier la cible avant de committer.
- Pas d'emojis.

## Interdits

- NEVER : dupliquer du contenu entre README, AGENTS.md et `docs/` — pointer, ne pas copier (les copies divergent en une semaine).
- NEVER : citer un fichier de code comme référence normative s'il n'existe pas.
- NEVER : créer un document « au cas où » — un document naît d'un besoin daté (voir la checklist de création de projet).
