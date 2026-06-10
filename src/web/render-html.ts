import type { DimensionReport, SessionReport } from '../report/aggregate.js';
import { totalTokens } from '../pricing/cost-model.js';
import { prettyProject } from '../parser/session-path.js';
import { formatDateTime, formatTokens, formatUsd } from '../format/currency.js';
import { renderChart, type Granularity, type SeriesPoint } from './timeseries.js';

/** Données nécessaires au rendu du tableau de bord. */
export interface DashboardData {
  /** Horodatage de génération (lisible). */
  generatedAt: string;
  byProject: DimensionReport;
  byModel: DimensionReport;
  byDay: DimensionReport;
  sessions: SessionReport;
  /** Série temporelle pour le graphique d'évolution. */
  series: SeriesPoint[];
  /** Granularité courante du graphique. */
  granularity: Granularity;
  /** Bornes de période sélectionnées (pour pré-remplir le formulaire). */
  since?: string;
  until?: string;
  /** Modèles non tarifés signalés (coût compté à 0). */
  unknownModels: string[];
}

/** Échappe les caractères spéciaux HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Largeur de barre (en %) proportionnelle au max d'une série. */
function barWidth(value: number, max: number): number {
  if (max <= 0) {
    return 0;
  }
  return Math.max(1, Math.round((value / max) * 100));
}

/** Rend une ligne de tableau « dimension » avec barre de coût proportionnelle. */
function dimensionRows(report: DimensionReport, maxCost: number): string {
  return report.rows
    .map((row) => {
      const width = barWidth(row.cost, maxCost);
      return `<tr>
        <td class="key">${escapeHtml(row.key)}</td>
        <td class="num">${row.messageCount}</td>
        <td class="num">${escapeHtml(formatTokens(totalTokens(row.counts)))}</td>
        <td class="cost">
          <div class="bar"><span style="width:${width}%"></span></div>
          <strong>${escapeHtml(formatUsd(row.cost))}</strong>
        </td>
      </tr>`;
    })
    .join('\n');
}

/** Rend une section « tableau par dimension ». */
function dimensionSection(title: string, keyLabel: string, report: DimensionReport): string {
  const maxCost = report.rows.reduce((m, r) => Math.max(m, r.cost), 0);
  return `<section>
    <h2>${escapeHtml(title)}</h2>
    <table>
      <thead><tr><th>${escapeHtml(keyLabel)}</th><th class="num">Msgs</th><th class="num">Tokens</th><th>Coût</th></tr></thead>
      <tbody>
        ${dimensionRows(report, maxCost)}
        <tr class="total">
          <td>TOTAL</td>
          <td class="num">${report.total.messageCount}</td>
          <td class="num">${escapeHtml(formatTokens(totalTokens(report.total.counts)))}</td>
          <td><strong>${escapeHtml(formatUsd(report.total.cost))}</strong></td>
        </tr>
      </tbody>
    </table>
  </section>`;
}

/** Rend la section « sessions ». */
function sessionsSection(report: SessionReport): string {
  const rows = report.rows
    .map(
      (row) => `<tr>
      <td class="mono">${escapeHtml(row.meta.sessionId.slice(0, 8))}</td>
      <td>${escapeHtml(prettyProject(row.meta.projectSlug, row.meta.cwd))}</td>
      <td>${escapeHtml(row.meta.title ?? '—')}</td>
      <td class="mono">${escapeHtml(formatDateTime(row.meta.lastTs))}</td>
      <td>${escapeHtml(row.models.map((m) => m.replace(/^claude-/, '')).join(', '))}</td>
      <td class="num">${row.messageCount}</td>
      <td class="num">${escapeHtml(formatTokens(totalTokens(row.counts)))}</td>
      <td class="cost"><strong>${escapeHtml(formatUsd(row.cost))}</strong></td>
    </tr>`,
    )
    .join('\n');
  return `<section>
    <h2>Sessions récentes</h2>
    <table>
      <thead><tr><th>Session</th><th>Projet</th><th>Titre</th><th>Dernière activité</th><th>Modèles</th><th class="num">Msgs</th><th class="num">Tokens</th><th>Coût</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

/** Bannière d'avertissement pour les modèles non tarifés. */
function unknownBanner(models: string[]): string {
  if (models.length === 0) {
    return '';
  }
  return `<div class="warn">⚠ Modèles non tarifés (coût compté à 0) : ${escapeHtml(models.join(', '))}</div>`;
}

/** Rend le formulaire de sélection de période et de granularité (soumission GET). */
function controlsForm(data: DashboardData): string {
  const daySel = data.granularity === 'day' ? ' selected' : '';
  const weekSel = data.granularity === 'week' ? ' selected' : '';
  return `<form method="get" class="controls">
    <label>Du <input type="date" name="since" value="${escapeHtml(data.since ?? '')}" /></label>
    <label>Au <input type="date" name="until" value="${escapeHtml(data.until ?? '')}" /></label>
    <label>Granularité
      <select name="granularity">
        <option value="day"${daySel}>Quotidien</option>
        <option value="week"${weekSel}>Hebdomadaire</option>
      </select>
    </label>
    <button type="submit">Appliquer</button>
    <a class="reset" href="/">Réinitialiser</a>
  </form>`;
}

/** Rend la section graphique d'évolution des coûts. */
function chartSection(data: DashboardData): string {
  const unit = data.granularity === 'week' ? 'hebdomadaire' : 'quotidienne';
  return `<section>
    <h2>Évolution des coûts (${escapeHtml(unit)})</h2>
    ${renderChart(data.series, data.granularity)}
  </section>`;
}

/**
 * Rend la page HTML complète du tableau de bord.
 * Aucune dépendance externe : CSS en ligne, rafraîchissement manuel.
 */
export function renderDashboard(data: DashboardData): string {
  const totalCost = data.byProject.total.cost;
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Claude Monitoring</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #0d1117; color: #e6edf3; }
    header { padding: 24px 32px; border-bottom: 1px solid #21262d; display: flex; align-items: baseline; gap: 24px; flex-wrap: wrap; }
    header h1 { margin: 0; font-size: 20px; }
    .grand { font-size: 28px; font-weight: 700; color: #3fb950; }
    .meta { color: #8b949e; font-size: 13px; }
    main { padding: 24px 32px; display: grid; gap: 32px; max-width: 1100px; }
    section h2 { font-size: 15px; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; }
    th { color: #8b949e; font-weight: 600; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.cost { text-align: right; white-space: nowrap; }
    td.cost strong { color: #3fb950; }
    .key { word-break: break-all; }
    .mono { font-family: ui-monospace, monospace; color: #8b949e; }
    tr.total td { font-weight: 700; border-top: 2px solid #30363d; }
    .bar { display: inline-block; width: 120px; height: 6px; background: #21262d; border-radius: 3px; margin-right: 8px; vertical-align: middle; overflow: hidden; }
    .bar span { display: block; height: 100%; background: #3fb950; }
    .warn { margin: 16px 32px 0; padding: 10px 14px; background: #3a2d00; border: 1px solid #9e7b00; border-radius: 6px; color: #f2cc60; }
    footer { padding: 16px 32px; color: #8b949e; font-size: 12px; }
    .controls { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; padding: 14px 16px; background: #161b22; border: 1px solid #21262d; border-radius: 8px; }
    .controls label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #8b949e; }
    .controls input, .controls select { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; font-size: 13px; }
    .controls button { background: #238636; color: #fff; border: 0; border-radius: 6px; padding: 7px 16px; font-size: 13px; cursor: pointer; }
    .controls .reset { color: #8b949e; font-size: 12px; text-decoration: none; align-self: center; }
    .chart { width: 100%; height: auto; }
    .chart .cbar { fill: #3fb950; }
    .chart .cbar:hover { fill: #56d364; }
    .chart .grid { stroke: #21262d; stroke-width: 1; }
    .chart .axis { stroke: #30363d; stroke-width: 1; }
    .chart .xlbl, .chart .ylbl { fill: #8b949e; font-size: 10px; font-family: ui-monospace, monospace; }
    .empty { color: #8b949e; }
  </style>
</head>
<body>
  <header>
    <h1>Claude Monitoring</h1>
    <span class="grand">${escapeHtml(formatUsd(totalCost))}</span>
    <span class="meta">au total · généré le ${escapeHtml(data.generatedAt)}</span>
  </header>
  ${unknownBanner(data.unknownModels)}
  <main>
    ${controlsForm(data)}
    ${chartSection(data)}
    ${dimensionSection('Coûts par projet', 'Projet', data.byProject)}
    ${dimensionSection('Coûts par modèle', 'Modèle', data.byModel)}
    ${dimensionSection('Coûts par jour', 'Jour', data.byDay)}
    ${sessionsSection(data.sessions)}
  </main>
  <footer>Rafraîchissez la page pour recharger les données (ré-ingestion incrémentale).</footer>
</body>
</html>`;
}
