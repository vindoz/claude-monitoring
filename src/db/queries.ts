import type { Db } from './database.js';
import { type UsageCounts } from '../pricing/cost-model.js';
import { FAST_MODE_SUFFIX } from '../pricing/model-normalizer.js';

/** Dimension d'agrégation des coûts. */
export type Dimension = 'project' | 'session' | 'model' | 'day';

/** Filtres communs aux requêtes d'analyse. */
export interface UsageFilters {
  /** Slug de projet exact. */
  project?: string;
  /** Borne inférieure de jour incluse (`YYYY-MM-DD`). */
  since?: string;
  /** Borne supérieure de jour incluse (`YYYY-MM-DD`). */
  until?: string;
  /** Identifiant de modèle exact (tel que stocké) ; inclut sa variante `@fast`. */
  model?: string;
}

/** Ligne d'usage agrégée par (valeur de dimension, modèle). */
export interface DimensionUsageRow {
  /** Valeur de la dimension (slug projet / sessionId / modèle / jour). */
  key: string;
  /** Modèle (nécessaire car le tarif en dépend). */
  model: string;
  messageCount: number;
  counts: UsageCounts;
}

/** Ligne d'usage agrégée par (jour, projet, modèle) — base du graphique empilé. */
export interface DayProjectUsageRow {
  day: string;
  project: string;
  model: string;
  messageCount: number;
  counts: UsageCounts;
}

/** Métadonnées d'une session. */
export interface SessionMeta {
  sessionId: string;
  projectSlug: string;
  cwd: string | null;
  title: string | null;
  firstTs: number | null;
  lastTs: number | null;
  gitBranch: string | null;
}

/** Métadonnées d'un sous-agent (titre, type, filiation, bornes temporelles). */
export interface AgentMetaRow {
  agentId: string;
  sessionId: string;
  projectSlug: string;
  agentType: string | null;
  /** Titre donné au lancement ; absent pour les agents de workflow. */
  description: string | null;
  /** Agent parent, pour les agents lancés par un autre agent. */
  parentAgentId: string | null;
  spawnDepth: number | null;
  firstTs: number | null;
  lastTs: number | null;
}

/** Ligne d'usage agrégée au grain (agent, modèle). */
export interface AgentUsageRow {
  agentId: string;
  sessionId: string;
  projectSlug: string;
  /** Modèle (nécessaire car le tarif en dépend). */
  model: string;
  messageCount: number;
  counts: UsageCounts;
}

/** Colonne SQL correspondant à une dimension. */
const DIMENSION_COLUMN: Record<Dimension, string> = {
  project: 'project_slug',
  session: 'session_id',
  model: 'model',
  day: 'day',
};

/** Construit la clause WHERE et ses paramètres à partir des filtres. */
function buildWhere(filters: UsageFilters): { clause: string; params: Record<string, string> } {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (filters.project) {
    conditions.push('project_slug = @project');
    params.project = filters.project;
  }
  if (filters.since) {
    conditions.push('day >= @since');
    params.since = filters.since;
  }
  if (filters.until) {
    conditions.push('day <= @until');
    params.until = filters.until;
  }
  if (filters.model) {
    // Un modèle nommé inclut son usage fast mode, compté sous la clé `<modèle>@fast` ; un
    // filtre déjà suffixé reste strict (`…@fast@fast` n'existe jamais).
    conditions.push('(model = @model OR model = @modelFast)');
    params.model = filters.model;
    params.modelFast = `${filters.model}${FAST_MODE_SUFFIX}`;
  }
  const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { clause, params };
}

/** Liste des colonnes `SUM(...)` partagée par les requêtes d'agrégation d'usage. */
const USAGE_SUMS = `SUM(message_count)         AS messageCount,
      SUM(input_tokens)          AS input,
      SUM(cache_write_5m_tokens) AS cw5,
      SUM(cache_write_1h_tokens) AS cw1,
      SUM(cache_read_tokens)     AS cacheRead,
      SUM(output_tokens)         AS output,
      SUM(web_search_requests)   AS webSearch,
      SUM(web_fetch_requests)    AS webFetch`;

/** Colonnes de tokens brutes renvoyées par SQLite (partagées par tous les agrégats). */
interface RawCounts {
  messageCount: number;
  input: number;
  cw5: number;
  cw1: number;
  cacheRead: number;
  output: number;
  webSearch: number;
  webFetch: number;
}

/** Ligne brute renvoyée par SQLite pour les agrégats par dimension. */
interface RawUsageRow extends RawCounts {
  key: string;
  model: string;
}

/** Ligne brute renvoyée par SQLite pour les agrégats par (jour, projet, modèle). */
interface RawDayProjectRow extends RawCounts {
  day: string;
  project: string;
  model: string;
}

/** Construit l'objet `UsageCounts` à partir des colonnes de tokens brutes. */
function rawToCounts(raw: RawCounts): UsageCounts {
  return {
    input: raw.input,
    cacheWrite5m: raw.cw5,
    cacheWrite1h: raw.cw1,
    cacheRead: raw.cacheRead,
    output: raw.output,
    webSearch: raw.webSearch,
    webFetch: raw.webFetch,
  };
}

/** Transforme une ligne brute en ligne d'usage typée. */
function toDimensionRow(raw: RawUsageRow): DimensionUsageRow {
  return {
    key: raw.key,
    model: raw.model,
    messageCount: raw.messageCount,
    counts: rawToCounts(raw),
  };
}

/**
 * Agrège l'usage par (dimension demandée, modèle). Le coût est calculé en aval (par modèle),
 * c'est pourquoi le modèle reste toujours présent dans le regroupement.
 */
export function getUsageByDimension(
  db: Db,
  dimension: Dimension,
  filters: UsageFilters = {},
): DimensionUsageRow[] {
  const column = DIMENSION_COLUMN[dimension];
  const { clause, params } = buildWhere(filters);
  const sql = `
    SELECT ${column} AS key, model,
      ${USAGE_SUMS}
    FROM usage_rollup
    ${clause}
    GROUP BY key, model`;
  const rows = db.prepare(sql).all(params) as RawUsageRow[];
  return rows.map(toDimensionRow);
}

/**
 * Agrège l'usage par (jour, projet, modèle). Sert à construire le graphique d'évolution
 * empilé par projet ; le coût est calculé en aval (par modèle), d'où la présence du modèle.
 */
export function getUsageByDayAndProject(
  db: Db,
  filters: UsageFilters = {},
): DayProjectUsageRow[] {
  const { clause, params } = buildWhere(filters);
  const sql = `
    SELECT day, project_slug AS project, model,
      ${USAGE_SUMS}
    FROM usage_rollup
    ${clause}
    GROUP BY day, project, model`;
  const rows = db.prepare(sql).all(params) as RawDayProjectRow[];
  return rows.map((raw) => ({
    day: raw.day,
    project: raw.project,
    model: raw.model,
    messageCount: raw.messageCount,
    counts: rawToCounts(raw),
  }));
}

/** Récupère les métadonnées de session (optionnellement filtrées par projet). */
export function getSessionsMeta(db: Db, filters: UsageFilters = {}): SessionMeta[] {
  const params: Record<string, string> = {};
  let clause = '';
  if (filters.project) {
    clause = 'WHERE project_slug = @project';
    params.project = filters.project;
  }
  const sql = `
    SELECT session_id AS sessionId, project_slug AS projectSlug, cwd, title,
           first_ts AS firstTs, last_ts AS lastTs, git_branch AS gitBranch
    FROM sessions
    ${clause}`;
  return db.prepare(sql).all(params) as SessionMeta[];
}

/**
 * Indique si la base possède le grain agent. Une base créée par une version antérieure et
 * ouverte en LECTURE SEULE (`--no-ingest`) n'a pas ces tables : les requêtes agent dégradent
 * alors à vide plutôt que de lever. Toute ouverture normale les crée définitivement.
 */
export function hasAgentTables(db: Db): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name IN ('agents', 'agent_rollup')`,
    )
    .get() as { n: number };
  return row.n === 2;
}

/**
 * Agrège l'usage des sous-agents par (agent, modèle). Le filtre de période porte sur
 * `agent_rollup.day`, construit par la même règle que `usage_rollup.day` : la fenêtre
 * temporelle d'un agent est donc toujours cohérente avec celle de sa session parente.
 */
export function getAgentUsage(db: Db, filters: UsageFilters = {}): AgentUsageRow[] {
  if (!hasAgentTables(db)) {
    return [];
  }
  const { clause, params } = buildWhere(filters);
  const sql = `
    SELECT agent_id AS agentId, session_id AS sessionId, project_slug AS projectSlug, model,
      ${USAGE_SUMS}
    FROM agent_rollup
    ${clause}
    GROUP BY agentId, model
    ORDER BY agentId, model`;
  const rows = db.prepare(sql).all(params) as Array<RawCounts & Omit<AgentUsageRow, 'counts' | 'messageCount'>>;
  return rows.map((raw) => ({
    agentId: raw.agentId,
    sessionId: raw.sessionId,
    projectSlug: raw.projectSlug,
    model: raw.model,
    messageCount: raw.messageCount,
    counts: rawToCounts(raw),
  }));
}

/**
 * Récupère les métadonnées des sous-agents. Comme `getSessionsMeta`, seul le filtre de projet
 * s'applique : la table `agents` n'a pas de colonne `day`, le filtre de période vit
 * exclusivement dans `agent_rollup`.
 */
export function getAgentsMeta(db: Db, filters: UsageFilters = {}): AgentMetaRow[] {
  if (!hasAgentTables(db)) {
    return [];
  }
  const params: Record<string, string> = {};
  let clause = '';
  if (filters.project) {
    clause = 'WHERE project_slug = @project';
    params.project = filters.project;
  }
  const sql = `
    SELECT agent_id AS agentId, session_id AS sessionId, project_slug AS projectSlug,
           agent_type AS agentType, description, parent_agent_id AS parentAgentId,
           spawn_depth AS spawnDepth, first_ts AS firstTs, last_ts AS lastTs
    FROM agents
    ${clause}
    ORDER BY agentId`;
  return db.prepare(sql).all(params) as AgentMetaRow[];
}

/** Ligne d'usage agrégée au grain (skill, modèle). */
export interface SkillUsageRow {
  /** Skill actif, ou `(hors skill)`. */
  skill: string;
  sessionId: string;
  projectSlug: string;
  /** Modèle (nécessaire car le tarif en dépend). */
  model: string;
  messageCount: number;
  counts: UsageCounts;
}

/** Arête de filiation entre deux skills, relevée sur une session. */
export interface SkillEdgeRow {
  sessionId: string;
  childSkill: string;
  parentSkill: string;
}

/** Ligne d'usage agrégée au grain (outil, skill) : appels et contexte injecté. */
export interface ToolUsageRow {
  /** Nom complet de l'outil (`Bash`, `mcp__jira__jira_get_issue`). */
  tool: string;
  /** Serveur d'appartenance (`mcp:jira`, `builtin`). */
  server: string;
  /** Skill actif au moment des appels, ou `(hors skill)`. */
  skill: string;
  projectSlug: string;
  callCount: number;
  errorCount: number;
  /** Caractères de texte injectés dans le contexte par les résultats (images exclues). */
  resultChars: number;
  resultImages: number;
}

/**
 * Indique si la base possède le grain skill. Même garde que `hasAgentTables` : une base créée
 * par une version antérieure et ouverte en LECTURE SEULE (`--no-ingest`) n'a pas ces tables.
 */
export function hasSkillTables(db: Db): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name IN ('skill_rollup', 'skill_edges')`,
    )
    .get() as { n: number };
  return row.n === 2;
}

/** Indique si la base possède le grain outil (même garde que `hasSkillTables`). */
export function hasToolTables(db: Db): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'tool_rollup'`)
    .get() as { n: number };
  return row.n === 1;
}

/**
 * Agrège l'usage par (skill, session, modèle). Le modèle reste dans le regroupement parce que
 * le tarif en dépend ; la session y reste parce que la racine d'une chaîne de skills se résout
 * session par session (un même skill peut être lancé par des parents différents ailleurs).
 */
export function getSkillUsage(db: Db, filters: UsageFilters = {}): SkillUsageRow[] {
  if (!hasSkillTables(db)) {
    return [];
  }
  const { clause, params } = buildWhere(filters);
  const sql = `
    SELECT skill, session_id AS sessionId, project_slug AS projectSlug, model,
      ${USAGE_SUMS}
    FROM skill_rollup
    ${clause}
    GROUP BY skill, sessionId, model
    ORDER BY skill, model`;
  const rows = db.prepare(sql).all(params) as Array<
    RawCounts & Omit<SkillUsageRow, 'counts' | 'messageCount'>
  >;
  return rows.map((raw) => ({
    skill: raw.skill,
    sessionId: raw.sessionId,
    projectSlug: raw.projectSlug,
    model: raw.model,
    messageCount: raw.messageCount,
    counts: rawToCounts(raw),
  }));
}

/**
 * Récupère les arêtes de filiation entre skills. Comme `getAgentsMeta`, seul le filtre de
 * projet s'applique : la table n'a pas de colonne `day`, et restreindre les arêtes à une
 * période reviendrait à perdre la racine des chaînes ouvertes avant elle.
 */
export function getSkillEdges(db: Db, filters: UsageFilters = {}): SkillEdgeRow[] {
  if (!hasSkillTables(db)) {
    return [];
  }
  const params: Record<string, string> = {};
  let clause = '';
  if (filters.project) {
    clause = 'WHERE project_slug = @project';
    params.project = filters.project;
  }
  const sql = `
    SELECT session_id AS sessionId, child_skill AS childSkill, parent_skill AS parentSkill
    FROM skill_edges
    ${clause}`;
  return db.prepare(sql).all(params) as SkillEdgeRow[];
}

/**
 * Agrège les appels d'outils par (outil, skill). Le filtre `model` est volontairement ignoré :
 * `tool_rollup` n'a pas de colonne `model`, un appel d'outil n'étant pas produit par un modèle
 * mais par un tour de boucle.
 */
export function getToolUsage(db: Db, filters: UsageFilters = {}): ToolUsageRow[] {
  if (!hasToolTables(db)) {
    return [];
  }
  const { clause, params } = buildWhere({
    project: filters.project,
    since: filters.since,
    until: filters.until,
  });
  const sql = `
    SELECT tool, server, skill, project_slug AS projectSlug,
      SUM(call_count)    AS callCount,
      SUM(error_count)   AS errorCount,
      SUM(result_chars)  AS resultChars,
      SUM(result_images) AS resultImages
    FROM tool_rollup
    ${clause}
    GROUP BY tool, skill
    ORDER BY callCount DESC`;
  return db.prepare(sql).all(params) as ToolUsageRow[];
}

/** Indique si la base ne contient encore aucune donnée d'usage. */
export function isDatabaseEmpty(db: Db): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM usage_rollup').get() as { n: number };
  return row.n === 0;
}
