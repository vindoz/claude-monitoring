# claude-monitoring

Outil de monitoring de **Claude Code** : visualisez vos sessions, agrégez vos coûts et
affichez en temps réel le coût et l'occupation du contexte directement dans Claude Code.

L'outil lit les transcripts locaux de Claude Code (`~/.claude/projects/**/*.jsonl`),
calcule les coûts (Claude Code ne les stocke pas) et les expose via une CLI (`ccmon`) ainsi
qu'un script de statusline.

## Fonctionnalités

1. **Lister les sessions** (`ccmon sessions`) — toutes les sessions, leur projet, leur titre,
   leur modèle, leurs tokens et leur **coût** calculé.
2. **Lister les sous-agents** (`ccmon agents`) — chaque agent lancé, **le modèle qu'il a
   utilisé**, son type, sa session et son coût.
3. **Coût par skill et par pipeline** (`ccmon skills`) — ce que chaque skill a réellement
   coûté, et le **pipeline** (racine de la chaîne d'invocation) dont il relève.
4. **Appels d'outils et serveurs MCP** (`ccmon tools`) — nombre d'appels, erreurs et
   **contexte injecté** par outil, par serveur MCP et par skill.
5. **Résumer les coûts** (`ccmon summary --by …`) — agrégation par **projet**, **session**,
   **modèle** ou **jour**.
6. **Coût de la session en cours** dans le statusline de Claude Code, avec le **skill en cours
   et son coût**, ainsi que le **nombre de sous-agents et leur modèle**.
7. **Occupation du contexte en temps réel** dans le statusline.
8. **Tableau de bord web** (`ccmon serve`) — page navigateur avec graphique d'évolution des
   coûts **empilé par projet** (quotidien/hebdomadaire, une couleur par projet + légende),
   sélecteur de période, tableaux par projet/modèle/jour, cartes **« Coûts par skill »** et
   **« Outils & serveurs MCP »**, et **sessions dépliables révélant leurs agents** (titre,
   modèle, type, coût).
9. **Auto-démarrage** (`ccmon install --autostart`) — ouvre le dashboard à l'ouverture d'une
   session Claude Code.

Les coûts des **sous-agents** (transcripts `subagents/**`) sont inclus dans le coût de leur
session parente, et détaillés agent par agent.

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

La ligne se termine par les **sous-agents** de la session et leur modèle, omis s'il n'y en a
aucun :

```
Opus 5 (1M context) · $1988.37 · ▓▓▓▓░░░░░░ 43% (428.8k) · 100 agents 100×opus-5
```

> **Performance** : le statusline est réaffiché en continu. Pour éviter de reparser toute la
> session à chaque rendu, l'agrégat de chaque transcript est mémorisé dans
> `~/.claude/claude-monitoring.statusline-cache.json`, et seuls les octets ajoutés depuis le
> rendu précédent sont relus. Mesuré sur une session de 152 Mo répartie en 101 transcripts :
> **645 ms au premier appel, puis 42 ms par tour** (budget : 300 ms). Le cache est purement
> dérivé : le supprimer ne fait que provoquer un recalcul.

## Utilisation

```sh
# Ingestion (incrémentale) des transcripts dans la base SQLite
ccmon ingest

# Lister les sessions (ingère automatiquement au préalable)
ccmon sessions --limit 30
ccmon sessions --project -home-user-projets-demo --json

# Lister les sous-agents et le modèle qu'ils ont utilisé
ccmon agents --limit 20
ccmon agents --session 8725c3a0            # préfixe de session accepté
ccmon agents --since 2026-08-01 --json

# Coût par skill, et pipeline dont chaque skill relève
ccmon skills
ccmon skills --pipeline epct-sexy --since 2026-09-01
ccmon skills --json

# Appels d'outils et contexte injecté (serveurs MCP inclus)
ccmon tools
ccmon tools --mcp                 # seulement les outils MCP
ccmon tools --server jira         # un serveur donné (le préfixe `mcp:` est optionnel)
ccmon tools --skill epct          # les appels passés sous un skill

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
- **Agents dépliables** : chaque session ayant lancé des sous-agents porte un chevron ; le
  déplier affiche ses agents avec **le titre, puis le modèle utilisé**, le type, les tokens et
  le coût. Les agents lancés par un autre agent sont indentés sous leur parent. Le dépliage est
  100 % CSS — le tableau de bord ne charge toujours aucun JavaScript.
- La dernière ligne du sous-tableau s'appelle **« reste »**, et non « boucle principale » :
  quand Claude Code a purgé les transcripts d'agents d'une vieille session, leur coût reste
  compté dans la session sans qu'aucun agent ne puisse être listé.
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
(USD par million de tokens, tarifs publics Anthropic relevés le 2026-09-23) :

| Modèle                 | input | output | cache write 5 min | cache write 1 h | cache read |
|------------------------|-------|--------|-------------------|-----------------|------------|
| Fable 5.1              | 10    | 50     | 12,50             | 20              | **0,25**   |
| Fable 5                | 10    | 50     | 12,50             | 20              | 1,00       |
| Opus 5.5               | 4     | 20     | 5                 | 8               | **0,20**   |
| Opus 4.5 → 5           | 5     | 25     | 6,25              | 10              | 0,50       |
| Opus 4 / 4.1 (anciens) | 15    | 75     | 18,75             | 30              | 1,50       |
| Sonnet 5               | 2     | 10     | 2,50              | 4               | 0,20       |
| Sonnet 4.5 / 4.6       | 3     | 15     | 3,75              | 6               | 0,30       |
| Haiku 4.5              | 1     | 5      | 1,25              | 2               | 0,10       |

La lecture de cache vaut partout 0,1 × le tarif d'entrée, **sauf sur deux modèles** : Fable 5.1,
où elle tombe à 0,025 × (0,25 $ au lieu de 1 $), et Opus 5.5, où elle tombe à 0,05 × (0,20 $ au
lieu de 0,40 $). Ces deux abattements ne valent que pour ces modèles précis.

Un modèle absent de la grille est tarifé au barème de la **génération courante de sa famille**
(`opus`, `sonnet`, `haiku`, `fable`), **sans** abattement de lecture : un identifiant Opus inconnu
compte 4 $ / 20 $ avec une lecture à 0,40 $, un identifiant Fable inconnu reste au barème de
Fable 5. Un modèle dont la famille elle-même est inconnue est
compté à 0 et **signalé** : la commande `summary` renvoie alors un code de sortie non nul.

Pour surcharger ou compléter ces tarifs, créez un fichier JSON et pointez `CCMON_PRICING`
dessus :

```json
{
  "claude-fable-5-1": { "input": 10, "output": 50, "cacheWrite5m": 12.5, "cacheWrite1h": 20, "cacheRead": 0.25 }
}
```

## Variables d'environnement

| Variable | Rôle | Défaut |
|----------|------|--------|
| `CCMON_CLAUDE_HOME` | racine de configuration Claude Code | `~/.claude` |
| `CCMON_PROJECTS_DIR` | répertoire des transcripts | `<claude_home>/projects` |
| `CCMON_DB` | fichier de base SQLite | `<claude_home>/claude-monitoring.db` |
| `CCMON_PRICING` | fichier de pricing override | `<claude_home>/claude-monitoring.pricing.json` |
| `CCMON_STATUSLINE_CACHE` | cache d'agrégation du statusline | `<claude_home>/claude-monitoring.statusline-cache.json` |
| `CCMON_PORT` | port du tableau de bord web | `4757` |

## Développement

```sh
npm run dev -- sessions     # exécution directe via tsx
npm run typecheck
npm test
npm run test:coverage
```

## Architecture

- `parser/` : lecture tolérante des transcripts JSONL, résolution des chemins, et identité des
  sous-agents (`agent-<id>.jsonl` + son `agent-<id>.meta.json` jumeau, qui porte le titre et le
  type de l'agent).
- `pricing/` : grille tarifaire, normalisation des modèles, calcul de coût.
- `db/` : schéma SQLite, ingestion incrémentale (déduplication par `message.id` + `requestId`),
  requêtes d'agrégation.
- `report/` : agrégation et calcul des coûts par dimension et par agent.
- `format/` : rendu terminal (tableaux, barre de contexte, montants).
- `statusline/` : calcul du coût de la session courante et cache d'agrégation incrémental.
- `web/` : rendu HTML du tableau de bord et série temporelle (graphique SVG).
- `commands/` : sous-commandes `ingest`, `sessions`, `agents`, `skills`, `tools`, `summary`,
  `statusline`, `serve`, `install`.

### Grain agent

Le grain agent (`agents`, `agent_rollup`) est ajouté **à côté** de `usage_rollup`, jamais en le
migrant : Claude Code purge les vieux transcripts, et la majorité des sessions présentes en base
ne sont plus reconstructibles depuis le disque — une migration destructive perdrait leur
historique définitivement. Le rollup d'un agent est recalculé intégralement à chaque lecture de
son transcript, ce qui le rend indépendant de la déduplication globale et donc rattrapable :
à la première exécution suivant la mise à jour, une passe complète indexe les agents déjà
ingérés, sans toucher aux coûts déjà comptés.
### Grain skill et grain outil

Même principe que le grain agent : trois tables ajoutées **à côté** de l'existant.

| Table | Contenu |
|---|---|
| `skill_rollup` | tokens **facturés** ventilés par skill actif |
| `skill_edges` | filiation `appelant → appelé`, d'où le **pipeline** (racine de la chaîne) |
| `tool_rollup` | appels, erreurs et **contexte injecté** par outil, serveur et skill |

L'attribution par skill est **exacte, pas estimée** : Claude Code écrit lui-même un champ
`attributionSkill` sur chaque message assistant, y compris dans les transcripts de sous-agents.
Les messages produits hors de tout skill sont imputés à la clé `(hors skill)` — une clé plutôt
qu'un `NULL`, pour que le grain skill totalise **exactement** le grain session.

Le grain skill possède sa **propre table de déduplication** (`seen_skill_messages`). S'adosser à
`seen_messages` aurait rendu le rattrapage inerte : cette table est déjà peuplée sur tout
l'historique, et la passe forcée n'aurait donc rien écrit.

Le grain outil, lui, se relève sur **toutes** les lignes du transcript : un message logique est
réparti à raison d'un bloc de contenu par ligne, et les `tool_use` vivent précisément sur les
lignes que la déduplication `(message.id, requestId)` rejette. Chaque appel est marqué dans
`seen_tool_calls`, qui n'est **jamais purgée** : un transcript d'agent est relu depuis la ligne 0
à chaque passage, et `ccmon ingest --force` relit tout — supprimer le marqueur après usage
referait monter les compteurs à chaque exécution.

#### Ce que ces grains ne savent pas

- **L'historique purgé n'est pas rejouable.** Les totaux de `ccmon skills` sont donc
  **inférieurs** à ceux de `ccmon summary` : les sessions dont Claude Code a supprimé le
  transcript gardent leur coût agrégé, mais aucune ventilation par skill.
- **Un skill est rattaché à son premier parent dans la session.** Si `/epct` est lancé deux fois
  dans une même session, une fois seul et une fois par `/kran`, le grain
  `(session, skill, modèle, jour)` ne sait pas les distinguer.
- **Le « contexte injecté » n'est pas un coût facturé.** Un appel d'outil ne se facture pas :
  c'est son résultat qui entre dans le contexte, et que paient les requêtes suivantes — d'autant
  plus longtemps que la session dure. Le chiffre affiché est une **estimation** (≈ 4 caractères
  par token) dérivée d'un nombre de caractères mesuré ; les images en sont exclues, leur base64
  n'ayant aucun rapport avec leur poids réel.

- `scripts/` : `statusline.sh` (relai stdin → `ccmon statusline`) et `session-start.sh`
  (hook d'auto-démarrage du dashboard).

La base de données n'est jamais committée (voir `.gitignore`) et reste en dehors du dépôt.
