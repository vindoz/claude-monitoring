/**
 * Définition du schéma SQLite. Le DDL est idempotent (`IF NOT EXISTS`) et rejoué à chaque
 * ouverture de base.
 *
 * Modèle de données :
 * - `ingested_files` : curseur d'ingestion incrémentale par fichier (taille + mtime + lignes lues) ;
 * - `sessions` : métadonnées de session (titre, projet, bornes temporelles) ;
 * - `usage_rollup` : consommation agrégée au grain session × modèle × jour ;
 * - `seen_messages` : déduplication des messages assistant déjà comptés ;
 * - `agents` / `agent_rollup` : grain sous-agent (titre, type, modèle, coût) ;
 * - `meta` : drapeaux internes (rattrapage du grain agent).
 *
 * Le grain agent est ajouté À CÔTÉ de l'existant, jamais en migrant `usage_rollup` : la
 * majorité des sessions de la base n'ont plus de transcript sur disque (purge de Claude Code)
 * et une reconstruction destructive perdrait définitivement leur historique.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ingested_files (
  path        TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  lines_read  INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL,
  cwd          TEXT,
  title        TEXT,
  first_ts     INTEGER,
  last_ts      INTEGER,
  git_branch   TEXT
);

CREATE TABLE IF NOT EXISTS usage_rollup (
  session_id            TEXT NOT NULL,
  project_slug          TEXT NOT NULL,
  model                 TEXT NOT NULL,
  day                   TEXT NOT NULL,
  message_count         INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  web_search_requests   INTEGER NOT NULL DEFAULT 0,
  web_fetch_requests    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, model, day)
);

CREATE TABLE IF NOT EXISTS seen_messages (
  message_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  PRIMARY KEY (message_id, request_id)
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id        TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  project_slug    TEXT NOT NULL,
  agent_type      TEXT,
  description     TEXT,
  parent_agent_id TEXT,
  spawn_depth     INTEGER,
  first_ts        INTEGER,
  last_ts         INTEGER
);

CREATE TABLE IF NOT EXISTS agent_rollup (
  agent_id              TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  project_slug          TEXT NOT NULL,
  model                 TEXT NOT NULL,
  day                   TEXT NOT NULL,
  message_count         INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  web_search_requests   INTEGER NOT NULL DEFAULT 0,
  web_fetch_requests    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, model, day)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rollup_project ON usage_rollup(project_slug);
CREATE INDEX IF NOT EXISTS idx_rollup_model   ON usage_rollup(model);
CREATE INDEX IF NOT EXISTS idx_rollup_day     ON usage_rollup(day);
CREATE INDEX IF NOT EXISTS idx_sessions_proj  ON sessions(project_slug, last_ts);
CREATE INDEX IF NOT EXISTS idx_agents_session       ON agents(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_rollup_session ON agent_rollup(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_rollup_day     ON agent_rollup(day);
`;

/**
 * Clé du drapeau de rattrapage du grain agent. Tant qu'elle est absente, l'ingestion s'exécute
 * une fois en mode forcé : sans cela, les transcripts d'agents déjà ingérés seraient sautés par
 * le curseur incrémental et le grain agent resterait vide sur tout l'historique existant.
 */
export const AGENTS_BACKFILLED_KEY = 'agents_backfilled';
