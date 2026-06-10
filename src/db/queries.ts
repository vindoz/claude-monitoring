import type { Db } from './database.js';
import { type UsageCounts } from '../pricing/cost-model.js';

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
  /** Identifiant de modèle exact (tel que stocké). */
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
    conditions.push('model = @model');
    params.model = filters.model;
  }
  const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { clause, params };
}

/** Ligne brute renvoyée par SQLite pour les agrégats d'usage. */
interface RawUsageRow {
  key: string;
  model: string;
  messageCount: number;
  input: number;
  cw5: number;
  cw1: number;
  cacheRead: number;
  output: number;
  webSearch: number;
  webFetch: number;
}

/** Transforme une ligne brute en ligne d'usage typée. */
function toDimensionRow(raw: RawUsageRow): DimensionUsageRow {
  return {
    key: raw.key,
    model: raw.model,
    messageCount: raw.messageCount,
    counts: {
      input: raw.input,
      cacheWrite5m: raw.cw5,
      cacheWrite1h: raw.cw1,
      cacheRead: raw.cacheRead,
      output: raw.output,
      webSearch: raw.webSearch,
      webFetch: raw.webFetch,
    },
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
      SUM(message_count)         AS messageCount,
      SUM(input_tokens)          AS input,
      SUM(cache_write_5m_tokens) AS cw5,
      SUM(cache_write_1h_tokens) AS cw1,
      SUM(cache_read_tokens)     AS cacheRead,
      SUM(output_tokens)         AS output,
      SUM(web_search_requests)   AS webSearch,
      SUM(web_fetch_requests)    AS webFetch
    FROM usage_rollup
    ${clause}
    GROUP BY key, model`;
  const rows = db.prepare(sql).all(params) as RawUsageRow[];
  return rows.map(toDimensionRow);
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

/** Indique si la base ne contient encore aucune donnée d'usage. */
export function isDatabaseEmpty(db: Db): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM usage_rollup').get() as { n: number };
  return row.n === 0;
}
