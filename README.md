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
5. **Tableau de bord web** (`ccmon serve`) — page navigateur avec graphique d'évolution des
   coûts **empilé par projet** (quotidien/hebdomadaire, une couleur par projet + légende),
   sélecteur de période, et tableaux par projet/modèle/jour.
6. **Auto-démarrage** (`ccmon install --autostart`) — ouvre le dashboard à l'ouverture d'une
   session Claude Code.

Les coûts des **sous-agents** (transcripts `subagents/**`) sont inclus dans le coût de leur
session parente.

## Démarrage rapide

```sh
npm install && npm run build      # 1. construire
node dist/cli.js install          # 2. intégrer à Claude Code (statusline + skill /sessions)
node dist/cli.js serve            # 3. ouvrir le tableau de bord → http://127.0.0.1:4757/
```

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
- `install --autostart` : ajoute un hook `SessionStart` qui démarre le tableau de bord
  (s'il ne tourne pas déjà) et l'ouvre dans le navigateur à l'ouverture d'une session
  Claude Code. Non inclus par défaut (comportement plus intrusif).

Après installation, le statusline de Claude Code affiche le modèle, le coût de la session et
une barre d'occupation du contexte. La skill `/sessions` liste vos sessions depuis n'importe
quelle session Claude Code.

> **Coût complet** : le statusline affiche le coût **réel** de la session calculé par `ccmon`
> (lectures de cache **et** sous-agents incluses, au tarif liste). Il est donc volontairement
> plus élevé que le chiffre natif de Claude Code, qui sous-compte le cache et les sous-agents
> ([issue #48040](https://github.com/anthropics/claude-code/issues/48040)). En cas d'échec du
> calcul, le statusline retombe sur le chiffre natif.

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

# Tableau de bord web
ccmon serve                       # http://127.0.0.1:4757/
ccmon serve --port 8080           # autre port
```

L'ingestion est **incrémentale** : seuls les fichiers nouveaux ou modifiés sont relus.
Les messages de progression et avertissements vont sur **stderr** ; la sortie `--json` reste
propre sur **stdout**.

## Tableau de bord web (`ccmon serve`)

Lance un serveur HTTP local (module Node natif, **sans dépendance**) servant un tableau de
bord à `http://127.0.0.1:4757/` (port modifiable via `--port` ou `CCMON_PORT`).

- **Graphique d'évolution** des coûts **empilé par projet** (chaque barre est découpée en
  segments colorés, un par projet, avec une légende), granularité **quotidienne** ou **hebdomadaire**.
- **Sélecteur de période** (« Du / Au ») qui filtre l'ensemble du tableau de bord.
- Tableaux **par projet, par modèle, par jour** + liste des **sessions récentes**.
- Recharger la page ré-ingère les nouveaux transcripts (incrémental).

### Ouverture automatique à chaque session (`--autostart`)

```sh
node dist/cli.js install --autostart
```

Ajoute un hook `SessionStart` qui, à l'ouverture d'une session Claude Code, démarre le
dashboard s'il ne tourne pas déjà et l'ouvre dans le navigateur.

> **Note de sécurité** : Claude Code peut bloquer l'écriture de ce hook dans `settings.json`
> (« persistance non autorisée »). Dans ce cas, lancez la commande vous-même (préfixe `!`
> dans le prompt), ou ajoutez manuellement dans l'objet `"hooks"` de `~/.claude/settings.json` :
>
> ```json
> "SessionStart": [
>   { "hooks": [ { "type": "command", "command": "<chemin>/scripts/session-start.sh" } ] }
> ]
> ```

## Tarification

Les coûts sont calculés à partir des tokens (`usage`) et d'une grille tarifaire par défaut
(USD par million de tokens, tarifs publics Anthropic relevés le 2026-06-11) :

| Modèle              | input | output | cache write 5 min | cache read |
|---------------------|-------|--------|-------------------|------------|
| Opus 4.5 → 4.8      | 5     | 25     | 6,25              | 0,50       |
| Opus 4 / 4.1 (anciens) | 15 | 75     | 18,75             | 1,50       |
| Sonnet              | 3     | 15     | 3,75              | 0,30       |
| Haiku               | 1     | 5      | 1,25              | 0,10       |
| Fable 5             | 10    | 50     | 12,50             | 1,00       |

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
| `CCMON_PORT` | port du tableau de bord web | `4757` |

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
- `web/` : rendu HTML du tableau de bord et série temporelle (graphique SVG).
- `commands/` : sous-commandes `ingest`, `sessions`, `summary`, `statusline`, `serve`, `install`.
- `scripts/` : `statusline.sh` (relai stdin → `ccmon statusline`) et `session-start.sh`
  (hook d'auto-démarrage du dashboard).

La base de données n'est jamais committée (voir `.gitignore`) et reste en dehors du dépôt.
