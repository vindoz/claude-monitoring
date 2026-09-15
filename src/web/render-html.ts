import type {
  AgentReportRow,
  DimensionReport,
  SessionReport,
  SkillReport,
  ToolReport,
} from '../report/aggregate.js';
import { estimateTokensFromChars } from '../report/aggregate.js';
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
  /** Sous-agents de chaque session, dépliables sous sa ligne. */
  agentsBySession: Map<string, AgentReportRow[]>;
  /** Consommation par skill, avec le pipeline (racine de chaîne) de chacun. */
  skills: SkillReport;
  /** Appels d'outils et contexte injecté, par outil et par serveur. */
  tools: ToolReport;
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

/** Raccourcit un identifiant de modèle pour l'affichage (`claude-opus-5` → `opus-5`). */
function shortModel(model: string): string {
  return model.replace(/^claude-/, '');
}

/**
 * Ordonne les agents d'une session pour l'affichage : chaque agent parent est immédiatement
 * suivi des agents qu'il a lancés. Un agent dont le parent n'est pas dans la liste (parent
 * purgé, ou hors période) est traité comme une racine plutôt que d'être perdu.
 */
function orderAgentsByFiliation(agents: AgentReportRow[]): Array<{ row: AgentReportRow; depth: number }> {
  const present = new Set(agents.map((a) => a.meta.agentId));
  const childrenOf = new Map<string, AgentReportRow[]>();
  const roots: AgentReportRow[] = [];

  for (const agent of agents) {
    const parent = agent.meta.parentAgentId;
    if (parent && present.has(parent)) {
      const siblings = childrenOf.get(parent);
      if (siblings) {
        siblings.push(agent);
      } else {
        childrenOf.set(parent, [agent]);
      }
    } else {
      roots.push(agent);
    }
  }

  const ordered: Array<{ row: AgentReportRow; depth: number }> = [];
  const visit = (row: AgentReportRow, depth: number): void => {
    ordered.push({ row, depth });
    for (const child of childrenOf.get(row.meta.agentId) ?? []) {
      visit(child, depth + 1);
    }
  };
  roots.forEach((root) => visit(root, 0));
  return ordered;
}

/**
 * Rend le sous-tableau des agents d'une session : le TITRE de l'agent, et derrière lui le
 * MODÈLE qu'il a réellement utilisé.
 *
 * La dernière ligne s'appelle « reste » et non « boucle principale » : quand les transcripts
 * d'agents d'une session ont été purgés par Claude Code, leur coût reste compté dans la session
 * sans qu'aucun agent ne puisse être listé. L'attribuer à la boucle principale serait inventer
 * une donnée qu'on ne possède plus.
 */
function agentsSubTable(agents: AgentReportRow[], sessionCost: number): string {
  const rows = orderAgentsByFiliation(agents)
    .map(({ row, depth }) => {
      const models = row.models.map(shortModel).join(', ');
      return `<tr>
        <td class="key" style="padding-left:${8 + depth * 18}px" title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</td>
        <td class="model">${escapeHtml(models === '' ? '—' : models)}</td>
        <td class="mono">${escapeHtml(row.meta.agentType ?? '—')}</td>
        <td class="num">${row.messageCount}</td>
        <td class="num">${escapeHtml(formatTokens(totalTokens(row.counts)))}</td>
        <td class="cost">${escapeHtml(formatUsd(row.cost))}</td>
      </tr>`;
    })
    .join('\n');

  const agentsCost = agents.reduce((sum, a) => sum + a.cost, 0);
  const rest = Math.max(0, sessionCost - agentsCost);

  return `<table class="sub">
    <thead><tr><th>Agent</th><th>Modèle</th><th>Type</th><th class="num">Msgs</th><th class="num">Tokens</th><th>Coût</th></tr></thead>
    <tbody>
      ${rows}
      <tr class="rest">
        <td colspan="5">reste (boucle principale + agents non reconstructibles)</td>
        <td class="cost">${escapeHtml(formatUsd(rest))}</td>
      </tr>
    </tbody>
  </table>`;
}

/** Rend la section « sessions », chaque ligne dépliant ses sous-agents. */
function sessionsSection(report: SessionReport, agentsBySession: Map<string, AgentReportRow[]>): string {
  const rows = report.rows
    .map((row) => {
      const agents = agentsBySession.get(row.meta.sessionId) ?? [];
      const toggleId = `ag-${escapeHtml(row.meta.sessionId)}`;
      // Sans agent, pas de chevron : une ligne qui ne déplie rien ne doit pas sembler cliquable.
      const toggle =
        agents.length === 0
          ? '<td class="toggle"></td>'
          : `<td class="toggle"><label for="${toggleId}"><input type="checkbox" id="${toggleId}" /><span class="chev"></span></label></td>`;

      const main = `<tr class="sess">
      ${toggle}
      <td class="mono">${escapeHtml(row.meta.sessionId.slice(0, 8))}</td>
      <td>${escapeHtml(prettyProject(row.meta.projectSlug, row.meta.cwd))}</td>
      <td>${escapeHtml(row.meta.title ?? '—')}</td>
      <td class="mono">${escapeHtml(formatDateTime(row.meta.lastTs))}</td>
      <td>${escapeHtml(row.models.map(shortModel).join(', '))}</td>
      <td class="num">${agents.length === 0 ? '—' : agents.length}</td>
      <td class="num">${row.messageCount}</td>
      <td class="num">${escapeHtml(formatTokens(totalTokens(row.counts)))}</td>
      <td class="cost"><strong>${escapeHtml(formatUsd(row.cost))}</strong></td>
    </tr>`;

      if (agents.length === 0) {
        return main;
      }
      return `${main}
    <tr class="kids"><td colspan="10">${agentsSubTable(agents, row.cost)}</td></tr>`;
    })
    .join('\n');

  return `<section class="card wide">
    <h2>Sessions récentes <span class="sub">cliquez une ligne pour voir ses agents</span></h2>
    <div class="tablewrap">
    <table>
      <thead><tr><th></th><th>Session</th><th>Projet</th><th>Titre</th><th>Dernière activité</th><th>Modèles</th><th class="num">Agents</th><th class="num">Msgs</th><th class="num">Tokens</th><th>Coût</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  </section>`;
}

/**
 * Rend la carte « Coûts par skill ». La colonne Pipeline porte la racine de la chaîne
 * d'invocation : un `/epct` lancé par `/epct-sexy` s'y rattache, au lieu d'apparaître comme
 * un usage indépendant.
 */
function skillsSection(report: SkillReport): string {
  if (report.rows.length === 0) {
    return '';
  }
  const maxCost = report.rows.reduce((m, r) => Math.max(m, r.cost), 0);
  const body = report.rows
    .map((row) => {
      const width = barWidth(row.cost, maxCost);
      const pipeline = row.rootSkill === row.skill ? '—' : row.rootSkill;
      return `<tr>
        <td class="key" title="${escapeHtml(row.skill)}">${escapeHtml(row.skill)}</td>
        <td class="mono">${escapeHtml(pipeline)}</td>
        <td class="num">${row.messageCount}</td>
        <td class="num">${escapeHtml(formatTokens(totalTokens(row.counts)))}</td>
        <td class="cost">
          <div class="bar"><span style="width:${width}%"></span></div>
          <strong>${escapeHtml(formatUsd(row.cost))}</strong>
        </td>
      </tr>`;
    })
    .join('\n');

  return `<section class="card">
    <h2>Coûts par skill <span class="sub">pipeline = racine de la chaîne</span></h2>
    <div class="tablewrap">
    <table>
      <thead><tr><th>Skill</th><th>Pipeline</th><th class="num">Msgs</th><th class="num">Tokens</th><th>Coût</th></tr></thead>
      <tbody>
        ${body}
        <tr class="total">
          <td colspan="2">TOTAL</td>
          <td class="num">${report.total.messageCount}</td>
          <td class="num">${escapeHtml(formatTokens(totalTokens(report.total.counts)))}</td>
          <td><strong>${escapeHtml(formatUsd(report.total.cost))}</strong></td>
        </tr>
      </tbody>
    </table>
    </div>
  </section>`;
}

/**
 * Rend la carte « Outils & serveurs MCP ».
 *
 * Volontairement SANS colonne de coût : un appel d'outil n'est pas facturé, c'est le contexte
 * que son résultat injecte qui se paie — et se repaie à chaque requête suivante de la session.
 * La colonne est donc une estimation de poids, signalée comme telle.
 */
function toolsSection(report: ToolReport): string {
  if (report.rows.length === 0) {
    return '';
  }
  const maxChars = report.rows.reduce((m, r) => Math.max(m, r.resultChars), 0);
  const serverRows = report.servers
    .map(
      (row) => `<tr>
        <td class="key">${escapeHtml(row.server)}</td>
        <td class="num">${row.callCount}</td>
        <td class="num">${escapeHtml(formatTokens(estimateTokensFromChars(row.resultChars)))}</td>
      </tr>`,
    )
    .join('\n');

  const toolRows = report.rows
    .map((row) => {
      const width = barWidth(row.resultChars, maxChars);
      return `<tr>
        <td class="key" title="${escapeHtml(row.tool)}">${escapeHtml(row.tool)}</td>
        <td class="mono">${escapeHtml(row.skill)}</td>
        <td class="num">${row.callCount}</td>
        <td class="num">${row.errorCount === 0 ? '—' : row.errorCount}</td>
        <td class="cost">
          <div class="bar"><span style="width:${width}%"></span></div>
          <strong>${escapeHtml(formatTokens(estimateTokensFromChars(row.resultChars)))}</strong>
        </td>
      </tr>`;
    })
    .join('\n');

  return `<section class="card">
    <h2>Outils &amp; serveurs MCP <span class="sub">contexte injecté, estimé</span></h2>
    <div class="tablewrap">
    <table>
      <thead><tr><th>Serveur</th><th class="num">Appels</th><th class="num">≈ Contexte</th></tr></thead>
      <tbody>${serverRows}</tbody>
    </table>
    <table>
      <thead><tr><th>Outil</th><th>Skill</th><th class="num">Appels</th><th class="num">Err.</th><th>≈ Contexte</th></tr></thead>
      <tbody>
        ${toolRows}
        <tr class="total">
          <td colspan="2">TOTAL</td>
          <td class="num">${report.total.callCount}</td>
          <td class="num">${report.total.errorCount}</td>
          <td><strong>${escapeHtml(formatTokens(estimateTokensFromChars(report.total.resultChars)))}</strong></td>
        </tr>
      </tbody>
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
        <td class="key" title="${escapeHtml(row.model)}">${escapeHtml(shortModel(row.model))}${badge}</td>
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
    /* Dépliage des sous-agents sous leur session : 100 % CSS, aucune dépendance ni script.
       La case à cocher reste dans le flux (focusable au clavier) mais invisible ; c'est le
       label qui rend toute la cellule cliquable. */
    td.toggle { width: 1.8em; padding-right: 0; }
    td.toggle label { display: block; cursor: pointer; color: var(--muted); user-select: none; }
    td.toggle input { position: absolute; width: 1px; height: 1px; opacity: 0; }
    td.toggle .chev::before { content: '▸'; }
    tr.sess:has(input:checked) td.toggle .chev::before { content: '▾'; }
    td.toggle input:focus-visible + .chev { outline: 2px solid var(--accent); border-radius: 3px; }
    tr.kids { display: none; }
    tr.sess:has(input:checked) + tr.kids { display: table-row; }
    tr.kids > td { padding: 4px 12px 14px 30px; background: color-mix(in srgb, var(--bg) 55%, transparent); }
    table.sub { width: 100%; border-collapse: collapse; font-size: .93em; }
    table.sub th { position: static; background: transparent; font-size: 10px; padding: 4px 8px; }
    table.sub td { padding: 5px 8px; border-bottom: 1px dashed var(--border); }
    table.sub td.model { color: var(--accent); white-space: nowrap; }
    table.sub tr.rest td { color: var(--muted); font-style: italic; border-bottom: 0; }
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
    ${dimensionSection('Coûts par modèle', 'Modèle', data.byModel, shortModel)}
    ${dimensionSection('Coûts par jour', 'Jour', data.byDay)}
    ${skillsSection(data.skills)}
    ${toolsSection(data.tools)}
    ${pricingSection(data.pricingRows)}
    ${sessionsSection(data.sessions, data.agentsBySession)}
  </main>
  <footer>Rafraîchissez la page pour recharger les données (ré-ingestion incrémentale).</footer>
</body>
</html>`;
}
