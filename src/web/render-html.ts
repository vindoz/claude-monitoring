import type { DimensionReport, SessionReport } from '../report/aggregate.js';
import type { ModelPricing } from '../pricing/default-pricing.js';
import type { PricingMatch } from '../pricing/pricing-loader.js';
import { totalTokens } from '../pricing/cost-model.js';
import { prettyProject } from '../parser/session-path.js';
import { formatDateTime, formatTokens, formatUsd } from '../format/currency.js';
import { projectLabel, renderStackedChart, type Granularity, type StackedSeries } from './timeseries.js';

/** Ligne de la grille tarifaire : tarif effectivement appliqué à un modèle rencontré. */
export interface PricingRow {
  model: string;
  /** Provenance du tarif (exact, repli par famille, non tarifé…). */
  match: PricingMatch;
  pricing: ModelPricing;
}

/** Données nécessaires au rendu du tableau de bord. */
export interface DashboardData {
  /** Horodatage de génération (lisible). */
  generatedAt: string;
  byProject: DimensionReport;
  byModel: DimensionReport;
  byDay: DimensionReport;
  sessions: SessionReport;
  /** Série temporelle empilée par projet pour le graphique d'évolution. */
  stacked: StackedSeries;
  /** Granularité courante du graphique. */
  granularity: Granularity;
  /** Bornes de période sélectionnées (pour pré-remplir le formulaire). */
  since?: string;
  until?: string;
  /** Modèles non tarifés signalés (coût compté à 0). */
  unknownModels: string[];
  /** Grille tarifaire appliquée aux modèles rencontrés sur la période. */
  pricingRows: PricingRow[];
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
function dimensionRows(report: DimensionReport, maxCost: number, formatKey: (key: string) => string): string {
  return report.rows
    .map((row) => {
      const width = barWidth(row.cost, maxCost);
      return `<tr>
        <td class="key" title="${escapeHtml(row.key)}">${escapeHtml(formatKey(row.key))}</td>
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

/**
 * Rend une section « tableau par dimension » (carte de la grille).
 * `formatKey` raccourcit la clé pour l'affichage (la valeur brute reste en infobulle).
 */
function dimensionSection(
  title: string,
  keyLabel: string,
  report: DimensionReport,
  formatKey: (key: string) => string = (key) => key,
): string {
  const maxCost = report.rows.reduce((m, r) => Math.max(m, r.cost), 0);
  return `<section class="card">
    <h2>${escapeHtml(title)}</h2>
    <div class="tablewrap">
    <table>
      <thead><tr><th>${escapeHtml(keyLabel)}</th><th class="num">Msgs</th><th class="num">Tokens</th><th>Coût</th></tr></thead>
      <tbody>
        ${dimensionRows(report, maxCost, formatKey)}
        <tr class="total">
          <td>TOTAL</td>
          <td class="num">${report.total.messageCount}</td>
          <td class="num">${escapeHtml(formatTokens(totalTokens(report.total.counts)))}</td>
          <td><strong>${escapeHtml(formatUsd(report.total.cost))}</strong></td>
        </tr>
      </tbody>
    </table>
    </div>
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
  return `<section class="card wide">
    <h2>Sessions récentes</h2>
    <div class="tablewrap">
    <table>
      <thead><tr><th>Session</th><th>Projet</th><th>Titre</th><th>Dernière activité</th><th>Modèles</th><th class="num">Msgs</th><th class="num">Tokens</th><th>Coût</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  </section>`;
}

/** Libellé français de la provenance d'un tarif. */
const MATCH_LABELS: Record<PricingMatch, string> = {
  exact: 'exact',
  family: 'famille',
  synthetic: 'gratuit',
  unknown: 'non tarifé',
};

/** Rend la carte « grille tarifaire » : tarifs réellement appliqués aux modèles rencontrés. */
function pricingSection(rows: PricingRow[]): string {
  if (rows.length === 0) {
    return '';
  }
  const body = rows
    .map((row) => {
      const p = row.pricing;
      const badge = row.match === 'exact' ? '' : ` <span class="badge${row.match === 'unknown' ? ' bad' : ''}">${escapeHtml(MATCH_LABELS[row.match])}</span>`;
      return `<tr>
        <td class="key" title="${escapeHtml(row.model)}">${escapeHtml(row.model.replace(/^claude-/, ''))}${badge}</td>
        <td class="num">${escapeHtml(formatUsd(p.input))}</td>
        <td class="num">${escapeHtml(formatUsd(p.cacheWrite5m))}</td>
        <td class="num">${escapeHtml(formatUsd(p.cacheWrite1h))}</td>
        <td class="num">${escapeHtml(formatUsd(p.cacheRead))}</td>
        <td class="num">${escapeHtml(formatUsd(p.output))}</td>
      </tr>`;
    })
    .join('\n');
  return `<section class="card">
    <h2>Grille tarifaire appliquée <span class="sub">USD / MTok</span></h2>
    <div class="tablewrap">
    <table>
      <thead><tr><th>Modèle</th><th class="num">Input</th><th class="num">Cache 5 min</th><th class="num">Cache 1 h</th><th class="num">Cache lect.</th><th class="num">Output</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    </div>
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

/** Rend la légende du graphique (pastille de couleur + libellé de projet). */
function chartLegend(series: StackedSeries): string {
  if (series.projects.length === 0) {
    return '';
  }
  const items = series.projects
    .map(
      (p) =>
        `<span class="lgi"><span class="sw" style="background:${p.color}"></span>${escapeHtml(p.label)}</span>`,
    )
    .join('');
  return `<div class="legend">${items}</div>`;
}

/** Rend la section graphique d'évolution des coûts empilé par projet. */
function chartSection(data: DashboardData): string {
  const unit = data.granularity === 'week' ? 'hebdomadaire' : 'quotidienne';
  return `<section class="card wide">
    <h2>Évolution des coûts par projet (${escapeHtml(unit)})</h2>
    ${renderStackedChart(data.stacked, data.granularity)}
    ${chartLegend(data.stacked)}
  </section>`;
}

/**
 * Rend la page HTML complète du tableau de bord.
 * Aucune dépendance externe : CSS en ligne, rafraîchissement manuel.
 */
export function renderDashboard(data: DashboardData): string {
  const total = data.byProject.total;
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Claude Monitoring</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117; --surface: #161b22; --border: #21262d; --border-strong: #30363d;
      --fg: #e6edf3; --muted: #8b949e; --accent: #3fb950; --accent-dark: #238636;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--fg); }
    /* En-tête KPI : collant, lisible quelle que soit la position de défilement. */
    header {
      position: sticky; top: 0; z-index: 10;
      padding: 14px clamp(16px, 2.5vw, 48px);
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 88%, transparent);
      backdrop-filter: blur(8px);
      display: flex; align-items: center; gap: clamp(16px, 2vw, 40px); flex-wrap: wrap;
    }
    header h1 { margin: 0; font-size: 17px; letter-spacing: .01em; }
    .kpis { display: flex; gap: clamp(14px, 2vw, 36px); flex-wrap: wrap; align-items: center; }
    .kpi { display: flex; flex-direction: column; gap: 1px; }
    .kpi .v { font-size: clamp(18px, 1.4vw, 24px); font-weight: 700; font-variant-numeric: tabular-nums; }
    .kpi .v.grand { color: var(--accent); }
    .kpi .l { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .meta { color: var(--muted); font-size: 12px; margin-left: auto; }
    /* Grille principale : 1 colonne sur mobile, 2 dès 1000 px, 3 sur grand écran.
       Paliers explicites (auto-fit ne redistribue pas la largeur quand des éléments
       pleine largeur occupent toutes les pistes). */
    main {
      padding: clamp(16px, 2.5vw, 48px);
      max-width: 2400px; margin-inline: auto;
      display: grid; gap: clamp(16px, 1.5vw, 28px);
      grid-template-columns: 1fr;
      align-items: start;
    }
    @media (min-width: 1000px) { main { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1500px) { main { grid-template-columns: repeat(3, 1fr); } }
    .wide, .controls { grid-column: 1 / -1; }
    .card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
      padding: clamp(14px, 1.2vw, 24px);
    }
    section h2 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin: 0 0 14px; }
    section h2 .sub { text-transform: none; letter-spacing: 0; font-weight: 400; opacity: .75; }
    .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; color: var(--muted); border: 1px solid var(--border-strong); vertical-align: 1px; }
    .badge.bad { color: #f2cc60; border-color: #9e7b00; }
    /* Tableaux : défilement interne borné (cartes équilibrées), en-têtes et TOTAL collants. */
    .tablewrap { overflow: auto; max-height: min(560px, 64vh); }
    .wide .tablewrap { max-height: min(720px, 72vh); }
    table { width: 100%; border-collapse: collapse; font-size: clamp(13px, .85vw, 15px); }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; white-space: nowrap; position: sticky; top: 0; background: var(--surface); z-index: 1; }
    tbody tr:hover { background: color-mix(in srgb, var(--fg) 4%, transparent); }
    td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.cost { text-align: right; white-space: nowrap; }
    td.cost strong { color: var(--accent); }
    .key { overflow-wrap: anywhere; }
    .mono { font-family: ui-monospace, monospace; color: var(--muted); }
    tr.total td { font-weight: 700; border-top: 2px solid var(--border-strong); border-bottom: 0; position: sticky; bottom: 0; background: var(--surface); }
    .bar { display: inline-block; width: clamp(80px, 6vw, 160px); height: 6px; background: var(--border); border-radius: 3px; margin-right: 8px; vertical-align: middle; overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--accent); }
    .warn { grid-column: 1 / -1; padding: 10px 14px; background: #3a2d00; border: 1px solid #9e7b00; border-radius: 8px; color: #f2cc60; }
    footer { padding: 16px clamp(16px, 2.5vw, 48px); color: var(--muted); font-size: 12px; }
    .controls { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
    .controls label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
    .controls input, .controls select { background: var(--bg); color: var(--fg); border: 1px solid var(--border-strong); border-radius: 6px; padding: 6px 8px; font-size: 13px; }
    .controls button { background: var(--accent-dark); color: #fff; border: 0; border-radius: 6px; padding: 7px 16px; font-size: 13px; cursor: pointer; }
    .controls button:hover { filter: brightness(1.1); }
    .controls .reset { color: var(--muted); font-size: 12px; text-decoration: none; align-self: center; }
    /* Graphique : pleine largeur de carte, plafonné et centré sur très grand écran
       (le ratio du viewBox est conservé, pas de déformation des libellés). */
    .chart { display: block; width: 100%; max-width: 1800px; height: auto; margin-inline: auto; }
    .chart .seg { stroke: var(--bg); stroke-width: .5; }
    .chart .seg:hover { opacity: .82; }
    .chart .grid { stroke: var(--border); stroke-width: 1; }
    .chart .axis { stroke: var(--border-strong); stroke-width: 1; }
    .chart .xlbl, .chart .ylbl { fill: var(--muted); font-size: 10px; font-family: ui-monospace, monospace; }
    .legend { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 12px; font-size: 12px; color: var(--muted); justify-content: center; }
    .legend .lgi { display: flex; align-items: center; gap: 6px; }
    .legend .sw { width: 11px; height: 11px; border-radius: 2px; display: inline-block; flex: 0 0 auto; }
    .empty { color: var(--muted); }
    @media (max-width: 720px) {
      header { position: static; }
      .meta { margin-left: 0; flex-basis: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Claude Monitoring</h1>
    <div class="kpis">
      <span class="kpi"><span class="v grand">${escapeHtml(formatUsd(total.cost))}</span><span class="l">Coût total</span></span>
      <span class="kpi"><span class="v">${escapeHtml(formatTokens(totalTokens(total.counts)))}</span><span class="l">Tokens</span></span>
      <span class="kpi"><span class="v">${total.messageCount}</span><span class="l">Messages</span></span>
      <span class="kpi"><span class="v">${data.sessions.rows.length}</span><span class="l">Sessions</span></span>
    </div>
    <span class="meta">généré le ${escapeHtml(data.generatedAt)}</span>
  </header>
  <main>
    ${unknownBanner(data.unknownModels)}
    ${controlsForm(data)}
    ${chartSection(data)}
    ${dimensionSection('Coûts par projet', 'Projet', data.byProject, projectLabel)}
    ${dimensionSection('Coûts par modèle', 'Modèle', data.byModel, (m) => m.replace(/^claude-/, ''))}
    ${dimensionSection('Coûts par jour', 'Jour', data.byDay)}
    ${pricingSection(data.pricingRows)}
    ${sessionsSection(data.sessions)}
  </main>
  <footer>Rafraîchissez la page pour recharger les données (ré-ingestion incrémentale).</footer>
</body>
</html>`;
}
