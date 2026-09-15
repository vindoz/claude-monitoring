import { getSkillEdges, getSkillUsage, type UsageFilters } from '../db/queries.js';
import { aggregateSkills, type SkillReport } from '../report/aggregate.js';
import { renderPipelinesTable, renderSkillsTable } from '../format/tables.js';
import { totalTokens } from '../pricing/cost-model.js';
import { writeErr, writeJson, writeOut } from '../format/output.js';
import { buildResolver, openForRead, warnUnknownModels, type CommonOptions } from './common.js';

/** Options de la commande `skills`. */
export interface SkillsCommandOptions extends CommonOptions {
  project?: string;
  since?: string;
  until?: string;
  /** Restreint aux skills d'un pipeline donné (le skill racine de la chaîne). */
  pipeline?: string;
  limit?: number;
  json?: boolean;
}

/** Sérialise un rapport de skills en objets JSON simples. */
function toJson(report: SkillReport): unknown {
  return {
    skills: report.rows.map((row) => ({
      skill: row.skill,
      pipeline: row.rootSkill,
      models: row.models,
      messageCount: row.messageCount,
      tokens: totalTokens(row.counts),
      counts: row.counts,
      costUsd: Number(row.cost.toFixed(6)),
    })),
    pipelines: report.pipelines.map((row) => ({
      pipeline: row.key,
      messageCount: row.messageCount,
      tokens: totalTokens(row.counts),
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

/**
 * Liste ce que chaque skill a coûté, et le pipeline (chaîne d'invocation) dont il relève.
 *
 * Le total de cette commande peut être INFÉRIEUR à celui de `ccmon summary` : le grain skill
 * n'existe que pour les transcripts encore présents sur disque, alors que les coûts agrégés
 * couvrent aussi les sessions dont Claude Code a purgé le transcript.
 */
export function runSkills(opts: SkillsCommandOptions): void {
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
    const full = aggregateSkills(getSkillUsage(db, filters), getSkillEdges(db, filters), buildResolver(opts.pricing));

    // Le filtre de pipeline s'applique après agrégation : la racine n'est connue qu'une fois
    // les arêtes résolues.
    const filtered: SkillReport = opts.pipeline
      ? {
          ...full,
          rows: full.rows.filter((row) => row.rootSkill === opts.pipeline),
          pipelines: full.pipelines.filter((row) => row.key === opts.pipeline),
        }
      : full;

    const limited: SkillReport =
      opts.limit && opts.limit > 0 ? { ...filtered, rows: filtered.rows.slice(0, opts.limit) } : filtered;

    if (opts.json) {
      writeJson(toJson(limited));
      return;
    }
    if (limited.rows.length === 0) {
      writeOut('Aucun skill ne correspond aux filtres.');
      return;
    }
    writeOut(renderSkillsTable(limited));
    if (limited.pipelines.length > 0) {
      writeOut('\nPar pipeline (racine de la chaîne d’invocation) :');
      writeOut(renderPipelinesTable(limited));
    }
    warnUnknownModels(full.unknownModels);
  } finally {
    db.close();
  }
}
