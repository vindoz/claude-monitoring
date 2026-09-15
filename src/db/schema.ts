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
 * - `skill_rollup` / `seen_skill_messages` : grain skill (tokens facturés par skill actif) ;
 * - `skill_edges` : filiation entre skills, d'où le « pipeline » (skill racine d'une chaîne) ;
 * - `tool_rollup` / `seen_tool_calls` : grain outil (appels, erreurs, contexte injecté) ;
 * - `meta` : drapeaux internes (rattrapages de grain).
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

CREATE TABLE IF NOT EXISTS skill_rollup (
  session_id            TEXT NOT NULL,
  project_slug          TEXT NOT NULL,
  skill                 TEXT NOT NULL,
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
  PRIMARY KEY (session_id, skill, model, day)
);

CREATE TABLE IF NOT EXISTS seen_skill_messages (
  message_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  PRIMARY KEY (message_id, request_id)
);

CREATE TABLE IF NOT EXISTS skill_edges (
  session_id   TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  child_skill  TEXT NOT NULL,
  parent_skill TEXT NOT NULL,
  first_ts     INTEGER,
  PRIMARY KEY (session_id, child_skill)
);

CREATE TABLE IF NOT EXISTS tool_rollup (
  session_id    TEXT NOT NULL,
  project_slug  TEXT NOT NULL,
  tool          TEXT NOT NULL,
  server        TEXT NOT NULL,
  skill         TEXT NOT NULL,
  day           TEXT NOT NULL,
  call_count    INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  result_chars  INTEGER NOT NULL DEFAULT 0,
  result_images INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, tool, skill, day)
);

CREATE TABLE IF NOT EXISTS seen_tool_calls (
  tool_use_id  TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  tool         TEXT NOT NULL,
  server       TEXT NOT NULL,
  skill        TEXT NOT NULL,
  day          TEXT NOT NULL,
  resolved     INTEGER NOT NULL DEFAULT 0
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
CREATE INDEX IF NOT EXISTS idx_skill_rollup_project ON skill_rollup(project_slug);
CREATE INDEX IF NOT EXISTS idx_skill_rollup_day     ON skill_rollup(day);
CREATE INDEX IF NOT EXISTS idx_skill_rollup_skill   ON skill_rollup(skill);
CREATE INDEX IF NOT EXISTS idx_tool_rollup_day      ON tool_rollup(day);
CREATE INDEX IF NOT EXISTS idx_tool_rollup_server   ON tool_rollup(server);
CREATE INDEX IF NOT EXISTS idx_tool_rollup_project  ON tool_rollup(project_slug);
`;

/**
 * Clé du drapeau de rattrapage du grain agent. Tant qu'elle est absente, l'ingestion s'exécute
 * une fois en mode forcé : sans cela, les transcripts d'agents déjà ingérés seraient sautés par
 * le curseur incrémental et le grain agent resterait vide sur tout l'historique existant.
 */
export const AGENTS_BACKFILLED_KEY = 'agents_backfilled';

/**
 * Clé du drapeau de rattrapage des grains skill et outil. Même mécanique que pour le grain
 * agent : tant qu'elle est absente, une passe forcée relit tout l'historique encore présent
 * sur disque.
 *
 * Le grain skill NE PEUT PAS s'adosser à `seen_messages` : cette table est déjà peuplée sur
 * tout l'historique, si bien qu'une passe forcée n'écrirait rien. D'où `seen_skill_messages`,
 * sa déduplication propre, alimentée EN AMONT de la barrière du grain session.
 */
export const SKILLS_BACKFILLED_KEY = 'skills_backfilled';
