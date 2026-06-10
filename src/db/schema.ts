/**
 * Définition du schéma SQLite. Le DDL est idempotent (`IF NOT EXISTS`) et rejoué à chaque
 * ouverture de base.
 *
 * Modèle de données :
 * - `ingested_files` : curseur d'ingestion incrémentale par fichier (taille + mtime + lignes lues) ;
 * - `sessions` : métadonnées de session (titre, projet, bornes temporelles) ;
 * - `usage_rollup` : consommation agrégée au grain session × modèle × jour ;
 * - `seen_messages` : déduplication des messages assistant déjà comptés.
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

CREATE INDEX IF NOT EXISTS idx_rollup_project ON usage_rollup(project_slug);
CREATE INDEX IF NOT EXISTS idx_rollup_model   ON usage_rollup(model);
CREATE INDEX IF NOT EXISTS idx_rollup_day     ON usage_rollup(day);
CREATE INDEX IF NOT EXISTS idx_sessions_proj  ON sessions(project_slug, last_ts);
`;
