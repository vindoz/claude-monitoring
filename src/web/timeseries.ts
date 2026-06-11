import type { DayProjectCost } from '../report/aggregate.js';
import { formatUsd } from '../format/currency.js';

/** Granularité de la série temporelle. */
export type Granularity = 'day' | 'week';

/**
 * Palette catégorielle pensée pour un fond sombre : un projet = une couleur,
 * attribuée dans l'ordre d'empilement (du plus coûteux au moins coûteux).
 */
const PALETTE = [
  '#3fb950', '#58a6ff', '#d29922', '#bc8cff',
  '#f778ba', '#39c5cf', '#ff7b72', '#e3b341',
];
/** Couleur (grise) du regroupement « Autres » (projets au-delà de la palette). */
const OTHER_COLOR = '#6e7681';
/** Clé synthétique du regroupement « Autres ». */
const OTHER_KEY = '__other__';

/** Contribution d'un projet à une barre (segment empilé). */
export interface StackSegment {
  /** Clé de projet (slug, ou `__other__` pour le regroupement). */
  project: string;
  cost: number;
}

/** Un point de la série : une barre empilée par projet sur une période. */
export interface StackedPoint {
  /** Étiquette (jour `YYYY-MM-DD` ou lundi de la semaine). */
  label: string;
  /** Coût total de la barre (somme des segments). */
  cost: number;
  messageCount: number;
  /** Segments dans l'ordre d'empilement global (segments à coût nul omis). */
  segments: StackSegment[];
}

/** Projet de la légende : clé, libellé lisible et couleur associée. */
export interface ProjectColor {
  project: string;
  label: string;
  color: string;
}

/** Série temporelle empilée : barres + légende des projets (même ordre/couleurs). */
export interface StackedSeries {
  points: StackedPoint[];
  projects: ProjectColor[];
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
 * Produit un libellé de projet court à partir de son slug.
 * Privilégie le segment après `-projets-` (`…-projets-claude-monitoring` → `claude-monitoring`) ;
 * à défaut, retire le tiret de tête. Le regroupement renvoie « Autres ».
 */
export function projectLabel(project: string): string {
  if (project === OTHER_KEY) {
    return 'Autres';
  }
  const marker = '-projets-';
  const i = project.lastIndexOf(marker);
  if (i >= 0) {
    return project.slice(i + marker.length);
  }
  return project.replace(/^-/, '') || project;
}

/**
 * Construit une série temporelle empilée par projet à partir des coûts (jour, projet).
 * Les `maxProjects` projets les plus coûteux gardent leur identité (et une couleur dédiée) ;
 * les suivants sont regroupés sous « Autres ». L'ordre d'empilement est global et stable,
 * pour que couleurs et légende coïncident d'une barre à l'autre. Jours « unknown » ignorés.
 */
export function buildStackedSeries(
  rows: DayProjectCost[],
  granularity: Granularity,
  maxProjects = PALETTE.length,
): StackedSeries {
  // 1. Coût total par projet (sert au classement et au seuil « Autres »).
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.day === 'unknown') {
      continue;
    }
    totals.set(r.project, (totals.get(r.project) ?? 0) + r.cost);
  }

  // 2. Classement décroissant ; au-delà de maxProjects → regroupement « Autres ».
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const kept = new Set(ranked.slice(0, maxProjects));
  const mapProject = (project: string): string => (kept.has(project) ? project : OTHER_KEY);

  // 3. Ordre d'empilement / légende (projets gardés, puis « Autres » s'il y a lieu).
  const order = ranked.filter((p) => kept.has(p));
  if (ranked.length > kept.size) {
    order.push(OTHER_KEY);
  }
  const projects: ProjectColor[] = order.map((project, i) => ({
    project,
    label: projectLabel(project),
    color: project === OTHER_KEY ? OTHER_COLOR : PALETTE[i % PALETTE.length],
  }));

  // 4. Regroupement par période, coût accumulé par projet mappé.
  interface Bucket {
    label: string;
    messageCount: number;
    perProject: Map<string, number>;
  }
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    if (r.day === 'unknown') {
      continue;
    }
    const label = granularity === 'week' ? weekStart(r.day) : r.day;
    const bucket = buckets.get(label) ?? { label, messageCount: 0, perProject: new Map() };
    const mapped = mapProject(r.project);
    bucket.perProject.set(mapped, (bucket.perProject.get(mapped) ?? 0) + r.cost);
    bucket.messageCount += r.messageCount;
    buckets.set(label, bucket);
  }

  // 5. Points triés chronologiquement ; segments dans l'ordre d'empilement global.
  const points: StackedPoint[] = [...buckets.values()]
    .sort((a, b) => (a.label < b.label ? -1 : 1))
    .map((bucket) => {
      const segments: StackSegment[] = [];
      let cost = 0;
      for (const project of order) {
        const c = bucket.perProject.get(project) ?? 0;
        if (c > 0) {
          segments.push({ project, cost: c });
          cost += c;
        }
      }
      return { label: bucket.label, cost, messageCount: bucket.messageCount, segments };
    });

  return { points, projects };
}

/** Dimensions du graphique SVG (ratio plat, pensé pour s'étirer en pleine largeur). */
const CHART = { width: 1200, height: 280, padL: 56, padR: 14, padT: 18, padB: 42 };

/** Échappe le texte injecté dans un `<title>` SVG (évite tout dépendance cyclique au rendu HTML). */
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rend un graphique en barres empilées (SVG, sans dépendance) de l'évolution des coûts.
 * Chaque barre est découpée en segments colorés par projet, avec une infobulle native
 * (`<title>`) par segment (projet + montant).
 */
export function renderStackedChart(series: StackedSeries, granularity: Granularity): string {
  if (series.points.length === 0) {
    return '<p class="empty">Aucune donnée sur la période sélectionnée.</p>';
  }
  const { width, height, padL, padR, padT, padB } = CHART;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const maxCost = Math.max(...series.points.map((p) => p.cost), 1);
  const n = series.points.length;
  const slot = plotW / n;
  const barW = Math.max(1, Math.min(slot * 0.72, 52));
  const labelStep = Math.max(1, Math.ceil(n / 16));
  const colorOf = new Map(series.projects.map((p) => [p.project, p.color]));

  const bars = series.points
    .map((point, i) => {
      const x = padL + i * slot + (slot - barW) / 2;
      const showLabel = i % labelStep === 0 || i === n - 1;
      const labelEl = showLabel
        ? `<text x="${(x + barW / 2).toFixed(1)}" y="${height - padB + 16}" class="xlbl" text-anchor="middle">${point.label.slice(5)}</text>`
        : '';
      // Empilement du bas (0 $) vers le haut.
      let yCursor = padT + plotH;
      const segs = point.segments
        .map((seg) => {
          const h = (seg.cost / maxCost) * plotH;
          yCursor -= h;
          const fill = colorOf.get(seg.project) ?? OTHER_COLOR;
          const tip = `${point.label} — ${escapeXml(projectLabel(seg.project))} : ${formatUsd(seg.cost)}`;
          return `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${fill}" class="seg"><title>${tip}</title></rect>`;
        })
        .join('');
      return segs + labelEl;
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
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="Évolution des coûts ${unit}, empilée par projet">
    ${grid}
    ${bars}
  </svg>`;
}
