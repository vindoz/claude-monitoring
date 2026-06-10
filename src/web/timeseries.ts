import type { CostedRow } from '../report/aggregate.js';
import { totalTokens } from '../pricing/cost-model.js';
import { formatUsd } from '../format/currency.js';

/** Granularité de la série temporelle. */
export type Granularity = 'day' | 'week';

/** Un point de la série temporelle. */
export interface SeriesPoint {
  /** Étiquette (jour `YYYY-MM-DD` ou début de semaine). */
  label: string;
  cost: number;
  tokens: number;
  messageCount: number;
}

/** Renvoie le lundi (UTC) de la semaine d'une date `YYYY-MM-DD`. */
export function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const dow = date.getUTCDay(); // 0 = dimanche
  const diff = dow === 0 ? 6 : dow - 1; // ramène au lundi
  date.setUTCDate(date.getUTCDate() - diff);
  return date.toISOString().slice(0, 10);
}

/**
 * Construit une série temporelle chronologique à partir des lignes agrégées par jour.
 * Les jours sans horodatage (`unknown`) sont ignorés.
 */
export function buildSeries(dayRows: CostedRow[], granularity: Granularity): SeriesPoint[] {
  const buckets = new Map<string, SeriesPoint>();
  for (const row of dayRows) {
    if (row.key === 'unknown') {
      continue;
    }
    const label = granularity === 'week' ? weekStart(row.key) : row.key;
    const point = buckets.get(label) ?? { label, cost: 0, tokens: 0, messageCount: 0 };
    point.cost += row.cost;
    point.tokens += totalTokens(row.counts);
    point.messageCount += row.messageCount;
    buckets.set(label, point);
  }
  return [...buckets.values()].sort((a, b) => (a.label < b.label ? -1 : 1));
}

/** Dimensions du graphique SVG. */
const CHART = { width: 880, height: 240, padL: 56, padR: 14, padT: 18, padB: 42 };

/**
 * Rend un graphique en barres (SVG, sans dépendance) de l'évolution des coûts.
 * Chaque barre porte une infobulle native (`<title>`) avec son montant.
 */
export function renderChart(series: SeriesPoint[], granularity: Granularity): string {
  if (series.length === 0) {
    return '<p class="empty">Aucune donnée sur la période sélectionnée.</p>';
  }
  const { width, height, padL, padR, padT, padB } = CHART;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const maxCost = Math.max(...series.map((p) => p.cost), 1);
  const n = series.length;
  const slot = plotW / n;
  const barW = Math.max(1, Math.min(slot * 0.72, 46));
  const labelStep = Math.max(1, Math.ceil(n / 12));

  const bars = series
    .map((point, i) => {
      const h = (point.cost / maxCost) * plotH;
      const x = padL + i * slot + (slot - barW) / 2;
      const y = padT + plotH - h;
      const showLabel = i % labelStep === 0 || i === n - 1;
      const labelEl = showLabel
        ? `<text x="${(x + barW / 2).toFixed(1)}" y="${height - padB + 16}" class="xlbl" text-anchor="middle">${point.label.slice(5)}</text>`
        : '';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" class="cbar"><title>${point.label} — ${formatUsd(point.cost)} (${point.messageCount} msgs)</title></rect>${labelEl}`;
    })
    .join('');

  // Axe Y : valeur max et milieu.
  const yMax = padT;
  const yMid = padT + plotH / 2;
  const yZero = padT + plotH;
  const grid = `
    <line x1="${padL}" y1="${yMax}" x2="${width - padR}" y2="${yMax}" class="grid" />
    <line x1="${padL}" y1="${yMid}" x2="${width - padR}" y2="${yMid}" class="grid" />
    <line x1="${padL}" y1="${yZero}" x2="${width - padR}" y2="${yZero}" class="axis" />
    <text x="${padL - 8}" y="${yMax + 4}" class="ylbl" text-anchor="end">${formatUsd(maxCost)}</text>
    <text x="${padL - 8}" y="${yMid + 4}" class="ylbl" text-anchor="end">${formatUsd(maxCost / 2)}</text>
    <text x="${padL - 8}" y="${yZero + 4}" class="ylbl" text-anchor="end">$0</text>`;

  const unit = granularity === 'week' ? 'par semaine' : 'par jour';
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="Évolution des coûts ${unit}">
    ${grid}
    ${bars}
  </svg>`;
}
