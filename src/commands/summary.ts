import { getUsageByDimension, type Dimension, type UsageFilters } from '../db/queries.js';
import { aggregateDimension, type DimensionReport } from '../report/aggregate.js';
import { renderDimensionTable } from '../format/tables.js';
import { totalTokens } from '../pricing/cost-model.js';
import { writeErr, writeJson, writeOut } from '../format/output.js';
import { buildResolver, openForRead, warnUnknownModels, type CommonOptions } from './common.js';

/** Libellés d'en-tête de colonne par dimension. */
const DIMENSION_LABELS: Record<Dimension, string> = {
  project: 'Projet',
  session: 'Session',
  model: 'Modèle',
  day: 'Jour',
};

/** Dimensions valides pour `--by`. */
export const VALID_DIMENSIONS: Dimension[] = ['project', 'session', 'model', 'day'];

/** Options de la commande `summary`. */
export interface SummaryCommandOptions extends CommonOptions {
  by: Dimension;
  project?: string;
  since?: string;
  until?: string;
  model?: string;
  limit?: number;
  json?: boolean;
}

/** Sérialise un rapport par dimension en objets JSON simples. */
function toJson(report: DimensionReport, dimension: Dimension): unknown {
  return {
    by: dimension,
    rows: report.rows.map((row) => ({
      key: row.key,
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

/** Agrège et affiche les coûts selon une dimension (projet / session / modèle / jour). */
export function runSummary(opts: SummaryCommandOptions): void {
  if (!VALID_DIMENSIONS.includes(opts.by)) {
    writeErr(`Dimension invalide : « ${opts.by} ». Valeurs possibles : ${VALID_DIMENSIONS.join(', ')}.`);
    process.exitCode = 2;
    return;
  }

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
      model: opts.model,
    };
    const usage = getUsageByDimension(db, opts.by, filters);
    const resolver = buildResolver(opts.pricing);
    const full = aggregateDimension(usage, resolver);

    const limited: DimensionReport =
      opts.limit && opts.limit > 0 ? { ...full, rows: full.rows.slice(0, opts.limit) } : full;

    if (opts.json) {
      writeJson(toJson(limited, opts.by));
    } else if (limited.rows.length === 0) {
      writeOut('Aucune donnée ne correspond aux filtres.');
    } else {
      writeOut(renderDimensionTable(limited, DIMENSION_LABELS[opts.by]));
      warnUnknownModels(full.unknownModels);
    }

    // Un coût silencieusement faux étant pire qu'une erreur : on signale par un code de sortie
    // non nul la présence de modèles non tarifés ayant consommé des tokens.
    if (full.unknownModels.length > 0) {
      process.exitCode = 3;
    }
  } finally {
    db.close();
  }
}
