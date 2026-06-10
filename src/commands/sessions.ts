import { getSessionsMeta, getUsageByDimension, type UsageFilters } from '../db/queries.js';
import { aggregateSessions, type SessionReport } from '../report/aggregate.js';
import { renderSessionsTable } from '../format/tables.js';
import { totalTokens } from '../pricing/cost-model.js';
import { writeErr, writeJson, writeOut } from '../format/output.js';
import { buildResolver, openForRead, warnUnknownModels, type CommonOptions } from './common.js';

/** Options de la commande `sessions`. */
export interface SessionsCommandOptions extends CommonOptions {
  project?: string;
  since?: string;
  until?: string;
  limit?: number;
  json?: boolean;
}

/** Sérialise un rapport de sessions en objets JSON simples. */
function toJson(report: SessionReport): unknown {
  return {
    sessions: report.rows.map((row) => ({
      sessionId: row.meta.sessionId,
      project: row.meta.projectSlug,
      cwd: row.meta.cwd,
      title: row.meta.title,
      firstTs: row.meta.firstTs,
      lastTs: row.meta.lastTs,
      gitBranch: row.meta.gitBranch,
      models: row.models,
      messageCount: row.messageCount,
      tokens: totalTokens(row.counts),
      counts: row.counts,
      costUsd: Number(row.cost.toFixed(6)),
    })),
    total: {
      messageCount: report.total.messageCount,
      tokens: totalTokens(report.total.counts),
      costUsd: Number(report.total.cost.toFixed(6)),
    },
    unknownModels: report.unknownModels,
  };
}

/** Liste les sessions Claude Code et leur coût agrégé. */
export function runSessions(opts: SessionsCommandOptions): void {
  const db = openForRead(opts);
  if (!db) {
    writeErr('Aucune base trouvée. Lancez d’abord `ccmon ingest`.');
    return;
  }
  try {
    const filters: UsageFilters = {
      project: opts.project,
      since: opts.since,
      until: opts.until,
    };
    const usage = getUsageByDimension(db, 'session', filters);
    const metas = getSessionsMeta(db, filters);
    const resolver = buildResolver(opts.pricing);
    const full = aggregateSessions(usage, metas, resolver);

    const limited: SessionReport =
      opts.limit && opts.limit > 0 ? { ...full, rows: full.rows.slice(0, opts.limit) } : full;

    if (opts.json) {
      writeJson(toJson(limited));
      return;
    }
    if (limited.rows.length === 0) {
      writeOut('Aucune session ne correspond aux filtres.');
      return;
    }
    writeOut(renderSessionsTable(limited));
    warnUnknownModels(full.unknownModels);
  } finally {
    db.close();
  }
}
