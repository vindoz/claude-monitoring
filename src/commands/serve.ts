import { createServer } from 'node:http';
import { openDatabase, type Db } from '../db/database.js';
import { ingest } from '../db/ingest.js';
import { getSessionsMeta, getUsageByDimension, type UsageFilters } from '../db/queries.js';
import {
  aggregateDimension,
  aggregateSessions,
  type DimensionReport,
} from '../report/aggregate.js';
import { renderDashboard, type DashboardData } from '../web/render-html.js';
import { buildSeries, type Granularity } from '../web/timeseries.js';
import type { PricingResolver } from '../pricing/pricing-loader.js';
import { writeErr, writeOut } from '../format/output.js';
import { buildResolver, resolveDbPath, resolveProjectsDir, type CommonOptions } from './common.js';

/** Options de la commande `serve`. */
export interface ServeOptions extends CommonOptions {
  port?: number;
  host?: string;
  /** Nombre de sessions affichées dans le tableau. */
  sessionsLimit?: number;
}

/** Valide qu'une chaîne est une date `YYYY-MM-DD`, sinon renvoie undefined. */
function sanitizeDay(value: string | null): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/** Trie un rapport par clé décroissante et limite le nombre de lignes (total inchangé). */
function topByKeyDesc(report: DimensionReport, limit: number): DimensionReport {
  const rows = [...report.rows].sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, limit);
  return { rows, total: report.total, unknownModels: report.unknownModels };
}

/** Paramètres de construction du tableau de bord. */
export interface DashboardParams {
  sessionsLimit: number;
  generatedAt: string;
  granularity: Granularity;
  since?: string;
  until?: string;
}

/** Construit les données du tableau de bord à partir de la base, filtrées par période. */
export function buildDashboardData(
  db: Db,
  resolver: PricingResolver,
  params: DashboardParams,
): DashboardData {
  const filters: UsageFilters = { since: params.since, until: params.until };

  const byProject = aggregateDimension(getUsageByDimension(db, 'project', filters), resolver);
  const byModel = aggregateDimension(getUsageByDimension(db, 'model', filters), resolver);
  const byDayFull = aggregateDimension(getUsageByDimension(db, 'day', filters), resolver);
  const byDay = topByKeyDesc(byDayFull, 30);
  const series = buildSeries(byDayFull.rows, params.granularity);

  const sessionsFull = aggregateSessions(
    getUsageByDimension(db, 'session', filters),
    getSessionsMeta(db),
    resolver,
  );
  const sessions = { ...sessionsFull, rows: sessionsFull.rows.slice(0, params.sessionsLimit) };

  const unknownModels = [...new Set([...byProject.unknownModels, ...byModel.unknownModels])];

  return {
    generatedAt: params.generatedAt,
    byProject,
    byModel,
    byDay,
    sessions,
    series,
    granularity: params.granularity,
    since: params.since,
    until: params.until,
    unknownModels,
  };
}

/** Lance le serveur web local exposant le tableau de bord. */
export function runServe(opts: ServeOptions): void {
  const port = opts.port ?? 4757;
  const host = opts.host ?? '127.0.0.1';
  const projectsDir = resolveProjectsDir(opts);
  const db = openDatabase(resolveDbPath(opts));
  const resolver = buildResolver(opts.pricing);
  const sessionsLimit = opts.sessionsLimit ?? 30;

  if (!opts.noIngest) {
    writeErr('Ingestion initiale…');
    ingest(db, projectsDir);
  }

  const server = createServer((req, res) => {
    const target = req.url ?? '/';
    if (target.startsWith('/health') || target.startsWith('/favicon')) {
      res.writeHead(target.startsWith('/health') ? 200 : 204).end();
      return;
    }
    try {
      // Rafraîchissement incrémental à chaque chargement (rapide après la 1re fois).
      if (!opts.noIngest) {
        ingest(db, projectsDir);
      }
      const url = new URL(target, `http://${host}:${port}`);
      const html = renderDashboard(
        buildDashboardData(db, resolver, {
          sessionsLimit,
          generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          granularity: url.searchParams.get('granularity') === 'week' ? 'week' : 'day',
          since: sanitizeDay(url.searchParams.get('since')),
          until: sanitizeDay(url.searchParams.get('until')),
        }),
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Erreur : ${(error as Error).message}`);
    }
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      writeErr(`Le port ${port} est déjà utilisé. Relancez avec --port <autre-port>.`);
    } else {
      writeErr(`Erreur du serveur : ${error.message}`);
    }
    db.close();
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    writeOut(`Tableau de bord Claude Monitoring : http://${host}:${port}/`);
    writeErr('Ctrl+C pour arrêter le serveur.');
  });
}
