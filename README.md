# claude-monitoring

Outil de monitoring de **Claude Code** : visualisez vos sessions, agrégez vos coûts et
affichez en temps réel le coût et l'occupation du contexte directement dans Claude Code.

L'outil lit les transcripts locaux de Claude Code (`~/.claude/projects/**/*.jsonl`),
calcule les coûts (Claude Code ne les stocke pas) et les expose via une CLI (`ccmon`) ainsi
qu'un script de statusline.

## Fonctionnalités

1. **Lister les sessions** (`ccmon sessions`) — toutes les sessions, leur projet, leur titre,
   leur modèle, leurs tokens et leur **coût** calculé.
2. **Résumer les coûts** (`ccmon summary --by …`) — agrégation par **projet**, **session**,
   **modèle** ou **jour**.
3. **Coût de la session en cours** dans le statusline de Claude Code.
4. **Occupation du contexte en temps réel** dans le statusline.

Les coûts des **sous-agents** (transcripts `subagents/**`) sont inclus dans le coût de leur
session parente.

## Prérequis

- Node.js ≥ 20

## Installation

```sh
npm install
npm run build
```

Pour disposer de la commande `ccmon` globalement (facultatif) :

```sh
npm link
```

## Intégration à Claude Code

Une commande installe les deux intégrations (sauvegarde `settings.json` en `.bak`, ajout
**non destructif** de la clé `statusLine`, et copie de la skill `/sessions`) :

```sh
node dist/cli.js install
```

- `install --statusline` : uniquement la statusline.
- `install --skill` : uniquement la skill `/sessions`.

Après installation, le statusline de Claude Code affiche le modèle, le coût de la session et
une barre d'occupation du contexte. La skill `/sessions` liste vos sessions depuis n'importe
quelle session Claude Code.

## Utilisation

```sh
# Ingestion (incrémentale) des transcripts dans la base SQLite
ccmon ingest

# Lister les sessions (ingère automatiquement au préalable)
ccmon sessions --limit 30
ccmon sessions --project -home-user-projets-demo --json

# Résumer les coûts
ccmon summary --by project
ccmon summary --by model
ccmon summary --by day --since 2026-06-01
ccmon summary --by session --json

# Statusline (lit le JSON de Claude Code sur stdin)
echo '{"cost":{"total_cost_usd":0.12},"context_window":{"used_percentage":32}}' | ccmon statusline
```

L'ingestion est **incrémentale** : seuls les fichiers nouveaux ou modifiés sont relus.
Les messages de progression et avertissements vont sur **stderr** ; la sortie `--json` reste
propre sur **stdout**.

## Tarification

Les coûts sont calculés à partir des tokens (`usage`) et d'une grille tarifaire par défaut
(USD par million de tokens) :

| Modèle | input | output | cache write 5 min | cache read |
|--------|-------|--------|-------------------|------------|
| Opus   | 15    | 75     | 18,75             | 1,50       |
| Sonnet | 3     | 15     | 3,75              | 0,30       |
| Haiku  | 1     | 5      | 1,25              | 0,10       |
| Fable 5| 10    | 50     | 12,50             | 1,00       |

Pour surcharger ou compléter ces tarifs, créez un fichier JSON et pointez `CCMON_PRICING`
dessus :

```json
{
  "claude-fable-5": { "input": 10, "output": 50, "cacheWrite5m": 12.5, "cacheWrite1h": 20, "cacheRead": 1 }
}
```

Un modèle non reconnu est compté à 0 et **signalé** (la commande `summary` renvoie alors un
code de sortie non nul).

## Variables d'environnement

| Variable | Rôle | Défaut |
|----------|------|--------|
| `CCMON_CLAUDE_HOME` | racine de configuration Claude Code | `~/.claude` |
| `CCMON_PROJECTS_DIR` | répertoire des transcripts | `<claude_home>/projects` |
| `CCMON_DB` | fichier de base SQLite | `<claude_home>/claude-monitoring.db` |
| `CCMON_PRICING` | fichier de pricing override | `<claude_home>/claude-monitoring.pricing.json` |

## Développement

```sh
npm run dev -- sessions     # exécution directe via tsx
npm run typecheck
npm test
npm run test:coverage
```

## Architecture

- `parser/` : lecture tolérante des transcripts JSONL et résolution des chemins.
- `pricing/` : grille tarifaire, normalisation des modèles, calcul de coût.
- `db/` : schéma SQLite, ingestion incrémentale (déduplication par `message.id` + `requestId`),
  requêtes d'agrégation.
- `report/` : agrégation et calcul des coûts par dimension.
- `format/` : rendu terminal (tableaux, barre de contexte, montants).
- `commands/` : sous-commandes `ingest`, `sessions`, `summary`, `statusline`, `install`.

La base de données n'est jamais committée (voir `.gitignore`) et reste en dehors du dépôt.
