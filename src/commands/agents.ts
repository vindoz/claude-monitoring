import { getAgentsMeta, getAgentUsage, type UsageFilters } from '../db/queries.js';
import { aggregateAgents, agentsInPeriod, type AgentReport } from '../report/aggregate.js';
import { renderAgentsTable } from '../format/tables.js';
import { totalTokens } from '../pricing/cost-model.js';
import { writeErr, writeJson, writeOut } from '../format/output.js';
import { buildResolver, openForRead, warnUnknownModels, type CommonOptions } from './common.js';

/** Options de la commande `agents`. */
export interface AgentsCommandOptions extends CommonOptions {
  project?: string;
  since?: string;
  until?: string;
  /** Restreint aux agents d'une session donnée (identifiant complet ou préfixe). */
  session?: string;
  limit?: number;
  json?: boolean;
}

/** Sérialise un rapport d'agents en objets JSON simples. */
function toJson(report: AgentReport): unknown {
  return {
    agents: report.rows.map((row) => ({
      agentId: row.meta.agentId,
      title: row.title,
      agentType: row.meta.agentType,
      models: row.models,
      sessionId: row.meta.sessionId,
      project: row.meta.projectSlug,
      parentAgentId: row.meta.parentAgentId,
      spawnDepth: row.meta.spawnDepth,
      firstTs: row.meta.firstTs,
      lastTs: row.meta.lastTs,
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

/** Liste les sous-agents Claude Code, leur modèle et leur coût. */
export function runAgents(opts: AgentsCommandOptions): void {
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
    const usage = getAgentUsage(db, filters);
    const metas = agentsInPeriod(
      getAgentsMeta(db, filters),
      usage,
      opts.since !== undefined || opts.until !== undefined,
    );
    const full = aggregateAgents(usage, metas, buildResolver(opts.pricing));

    // Le filtre de session s'applique après agrégation : il accepte un préfixe, comme les
    // identifiants tronqués affichés par les tableaux.
    const filtered: AgentReport = opts.session
      ? { ...full, rows: full.rows.filter((row) => row.meta.sessionId.startsWith(opts.session!)) }
      : full;

    const limited: AgentReport =
      opts.limit && opts.limit > 0 ? { ...filtered, rows: filtered.rows.slice(0, opts.limit) } : filtered;

    if (opts.json) {
      writeJson(toJson(limited));
      return;
    }
    if (limited.rows.length === 0) {
      writeOut('Aucun sous-agent ne correspond aux filtres.');
      return;
    }
    writeOut(renderAgentsTable(limited));
    warnUnknownModels(full.unknownModels);
  } finally {
    db.close();
  }
}
