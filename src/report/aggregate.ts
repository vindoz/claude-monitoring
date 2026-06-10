import type { DimensionUsageRow, SessionMeta } from '../db/queries.js';
import type { PricingResolver } from '../pricing/pricing-loader.js';
import { addUsage, costOf, totalTokens, zeroUsage, type UsageCounts } from '../pricing/cost-model.js';

/** Ligne d'un rapport par dimension, avec coût calculé. */
export interface CostedRow {
  key: string;
  messageCount: number;
  counts: UsageCounts;
  cost: number;
}

/** Rapport agrégé par dimension. */
export interface DimensionReport {
  rows: CostedRow[];
  total: CostedRow;
  /** Modèles non tarifés ayant pourtant consommé des tokens (signalement). */
  unknownModels: string[];
}

/** Crée une ligne de coût vide pour une clé donnée. */
function emptyRow(key: string): CostedRow {
  return { key, messageCount: 0, counts: zeroUsage(), cost: 0 };
}

/**
 * Résout le tarif d'une ligne d'usage, signale un éventuel modèle non tarifé et accumule
 * la ligne dans le total. Mutualise la logique commune aux deux agrégations.
 * @returns le coût calculé de la ligne.
 */
function resolveAndAccumulate(
  row: DimensionUsageRow,
  resolver: PricingResolver,
  total: CostedRow,
  unknownModels: Set<string>,
): number {
  const resolved = resolver.resolve(row.model);
  if (resolved.match === 'unknown' && totalTokens(row.counts) > 0) {
    unknownModels.add(resolved.canonical);
  }
  const cost = costOf(row.counts, resolved.pricing);
  total.messageCount += row.messageCount;
  total.counts = addUsage(total.counts, row.counts);
  total.cost += cost;
  return cost;
}

/**
 * Agrège des lignes d'usage (par clé × modèle) en un rapport par dimension, coût calculé.
 * Le coût est évalué par modèle (les tarifs diffèrent) avant d'être sommé par clé.
 */
export function aggregateDimension(
  rows: DimensionUsageRow[],
  resolver: PricingResolver,
): DimensionReport {
  const byKey = new Map<string, CostedRow>();
  const total = emptyRow('TOTAL');
  const unknownModels = new Set<string>();

  for (const row of rows) {
    const cost = resolveAndAccumulate(row, resolver, total, unknownModels);
    const current = byKey.get(row.key) ?? emptyRow(row.key);
    current.messageCount += row.messageCount;
    current.counts = addUsage(current.counts, row.counts);
    current.cost += cost;
    byKey.set(row.key, current);
  }

  const sorted = [...byKey.values()].sort((a, b) => b.cost - a.cost);
  return { rows: sorted, total, unknownModels: [...unknownModels] };
}

/** Ligne d'un rapport de sessions (métadonnées + coût). */
export interface SessionReportRow {
  meta: SessionMeta;
  models: string[];
  messageCount: number;
  counts: UsageCounts;
  cost: number;
}

/** Rapport de sessions. */
export interface SessionReport {
  rows: SessionReportRow[];
  total: CostedRow;
  unknownModels: string[];
}

/**
 * Combine l'usage par session (clé = sessionId) avec les métadonnées de session pour produire
 * un rapport coûté, trié par activité la plus récente.
 */
export function aggregateSessions(
  usageRows: DimensionUsageRow[],
  metas: SessionMeta[],
  resolver: PricingResolver,
): SessionReport {
  const metaById = new Map(metas.map((m) => [m.sessionId, m]));
  const acc = new Map<
    string,
    { models: Set<string>; messageCount: number; counts: UsageCounts; cost: number }
  >();
  const total = emptyRow('TOTAL');
  const unknownModels = new Set<string>();

  for (const row of usageRows) {
    const cost = resolveAndAccumulate(row, resolver, total, unknownModels);
    const current = acc.get(row.key) ?? {
      models: new Set<string>(),
      messageCount: 0,
      counts: zeroUsage(),
      cost: 0,
    };
    current.models.add(row.model);
    current.messageCount += row.messageCount;
    current.counts = addUsage(current.counts, row.counts);
    current.cost += cost;
    acc.set(row.key, current);
  }

  const rows: SessionReportRow[] = [];
  for (const [sessionId, agg] of acc) {
    const meta = metaById.get(sessionId) ?? {
      sessionId,
      projectSlug: '',
      cwd: null,
      title: null,
      firstTs: null,
      lastTs: null,
      gitBranch: null,
    };
    rows.push({
      meta,
      models: [...agg.models].sort(),
      messageCount: agg.messageCount,
      counts: agg.counts,
      cost: agg.cost,
    });
  }
  rows.sort((a, b) => (b.meta.lastTs ?? 0) - (a.meta.lastTs ?? 0));

  return { rows, total, unknownModels: [...unknownModels] };
}
