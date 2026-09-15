import { getToolUsage, type UsageFilters } from '../db/queries.js';
import { aggregateTools, estimateTokensFromChars, type ToolReport } from '../report/aggregate.js';
import { renderServersTable, renderToolsTable } from '../format/tables.js';
import { writeErr, writeJson, writeOut } from '../format/output.js';
import { openForRead, type CommonOptions } from './common.js';

/** Options de la commande `tools`. */
export interface ToolsCommandOptions extends CommonOptions {
  project?: string;
  since?: string;
  until?: string;
  /** Restreint à un serveur (`mcp:jira`, `builtin`, ou simplement `jira`). */
  server?: string;
  /** Ne garde que les outils exposés par un serveur MCP. */
  mcp?: boolean;
  /** Restreint aux appels passés sous un skill donné. */
  skill?: string;
  limit?: number;
  json?: boolean;
}

/** Sérialise un rapport d'outils. `estimatedTokens` est explicitement nommé comme une estimation. */
function toJson(report: ToolReport): unknown {
  return {
    tools: report.rows.map((row) => ({
      tool: row.tool,
      server: row.server,
      skill: row.skill,
      callCount: row.callCount,
      errorCount: row.errorCount,
      resultChars: row.resultChars,
      resultImages: row.resultImages,
      estimatedTokens: estimateTokensFromChars(row.resultChars),
    })),
    servers: report.servers.map((row) => ({
      server: row.server,
      callCount: row.callCount,
      errorCount: row.errorCount,
      resultChars: row.resultChars,
      resultImages: row.resultImages,
      estimatedTokens: estimateTokensFromChars(row.resultChars),
    })),
    total: {
      callCount: report.total.callCount,
      errorCount: report.total.errorCount,
      resultChars: report.total.resultChars,
      resultImages: report.total.resultImages,
      estimatedTokens: estimateTokensFromChars(report.total.resultChars),
    },
  };
}

/**
 * Normalise un nom de serveur donné en ligne de commande : `jira` et `mcp:jira` désignent le
 * même serveur, l'utilisateur ne devant pas avoir à connaître le préfixe interne.
 */
function normalizeServer(value: string): string {
  return value.startsWith('mcp:') || value === 'builtin' ? value : `mcp:${value}`;
}

/**
 * Liste les appels d'outils et le CONTEXTE qu'ils injectent, par outil, serveur MCP et skill.
 *
 * Aucun coût n'est affiché : un appel d'outil n'est pas facturé, c'est son résultat qui entre
 * dans le contexte et que paient les requêtes suivantes — d'autant plus longtemps que la
 * session dure. Le chiffre affiché est une estimation dérivée d'un nombre de caractères mesuré.
 */
export function runTools(opts: ToolsCommandOptions): void {
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
    let rows = getToolUsage(db, filters);
    if (opts.mcp) {
      rows = rows.filter((row) => row.server.startsWith('mcp:'));
    }
    if (opts.server) {
      const wanted = normalizeServer(opts.server);
      rows = rows.filter((row) => row.server === wanted);
    }
    if (opts.skill) {
      rows = rows.filter((row) => row.skill === opts.skill);
    }

    const full = aggregateTools(rows);
    const limited: ToolReport =
      opts.limit && opts.limit > 0 ? { ...full, rows: full.rows.slice(0, opts.limit) } : full;

    if (opts.json) {
      writeJson(toJson(limited));
      return;
    }
    if (limited.rows.length === 0) {
      writeOut('Aucun appel d’outil ne correspond aux filtres.');
      return;
    }
    writeOut(renderToolsTable(limited));
    if (limited.servers.length > 0) {
      writeOut('\nPar serveur :');
      writeOut(renderServersTable(limited));
    }
    writeErr('« ≈ Contexte » est une estimation (≈ 4 caractères par token) ; les images en sont exclues.');
  } finally {
    db.close();
  }
}
