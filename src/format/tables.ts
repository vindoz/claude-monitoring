import Table from 'cli-table3';
import pc from 'picocolors';
import type {
  AgentReport,
  DimensionReport,
  SessionReport,
  SkillReport,
  ToolReport,
} from '../report/aggregate.js';
import { estimateTokensFromChars } from '../report/aggregate.js';
import { totalTokens, type UsageCounts } from '../pricing/cost-model.js';
import { prettyProject } from '../parser/session-path.js';
import { formatDateTime, formatTokens, formatUsd } from './currency.js';

/** Tronque une chaîne à une longueur maximale (avec « … »). */
function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Raccourcit un identifiant de modèle pour l'affichage (`claude-opus-4-8` → `opus-4-8`). */
function shortModel(model: string): string {
  return model.replace(/^claude-/, '');
}

/** Total des tokens d'écriture de cache (5 min + 1 h). */
function cacheWrite(counts: UsageCounts): number {
  return counts.cacheWrite5m + counts.cacheWrite1h;
}

/**
 * Rend un tableau de rapport agrégé par dimension (projet / session / modèle / jour).
 * @param label en-tête de la colonne de dimension.
 */
export function renderDimensionTable(report: DimensionReport, label: string): string {
  const table = new Table({
    head: [label, 'Msgs', 'Input', 'Cache W', 'Cache R', 'Output', 'Coût'].map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });

  for (const row of report.rows) {
    table.push([
      truncate(row.key, 42),
      row.messageCount,
      formatTokens(row.counts.input),
      formatTokens(cacheWrite(row.counts)),
      formatTokens(row.counts.cacheRead),
      formatTokens(row.counts.output),
      pc.green(formatUsd(row.cost)),
    ]);
  }

  const t = report.total;
  table.push([
    pc.bold('TOTAL'),
    pc.bold(String(t.messageCount)),
    pc.bold(formatTokens(t.counts.input)),
    pc.bold(formatTokens(cacheWrite(t.counts))),
    pc.bold(formatTokens(t.counts.cacheRead)),
    pc.bold(formatTokens(t.counts.output)),
    pc.bold(pc.green(formatUsd(t.cost))),
  ]);

  return table.toString();
}

/** Rend le tableau de la liste des sessions. */
export function renderSessionsTable(report: SessionReport): string {
  const table = new Table({
    head: ['Session', 'Projet', 'Titre', 'Dernière activité', 'Modèles', 'Msgs', 'Tokens', 'Coût'].map(
      (h) => pc.bold(h),
    ),
    style: { head: [], border: [] },
  });

  for (const row of report.rows) {
    table.push([
      row.meta.sessionId.slice(0, 8),
      truncate(prettyProject(row.meta.projectSlug, row.meta.cwd), 24),
      truncate(row.meta.title ?? '—', 32),
      formatDateTime(row.meta.lastTs),
      row.models.map(shortModel).join(', '),
      row.messageCount,
      formatTokens(totalTokens(row.counts)),
      pc.green(formatUsd(row.cost)),
    ]);
  }

  table.push([
    pc.bold(`${report.rows.length} sessions`),
    '',
    '',
    '',
    '',
    pc.bold(String(report.total.messageCount)),
    pc.bold(formatTokens(totalTokens(report.total.counts))),
    pc.bold(pc.green(formatUsd(report.total.cost))),
  ]);

  return table.toString();
}

/**
 * Rend le tableau des sous-agents : le titre de l'agent, puis le MODÈLE qu'il a utilisé.
 * L'ordre des colonnes place le modèle juste derrière le titre, là où on le cherche.
 */
export function renderAgentsTable(report: AgentReport): string {
  const table = new Table({
    head: ['Agent', 'Modèle', 'Type', 'Projet', 'Session', 'Dernière activité', 'Msgs', 'Tokens', 'Coût'].map(
      (h) => pc.bold(h),
    ),
    style: { head: [], border: [] },
  });

  for (const row of report.rows) {
    table.push([
      truncate(row.title, 40),
      row.models.map(shortModel).join(', ') || '—',
      truncate(row.meta.agentType ?? '—', 16),
      truncate(prettyProject(row.meta.projectSlug), 20),
      row.meta.sessionId.slice(0, 8),
      formatDateTime(row.meta.lastTs),
      row.messageCount,
      formatTokens(totalTokens(row.counts)),
      pc.green(formatUsd(row.cost)),
    ]);
  }

  table.push([
    pc.bold(`${report.rows.length} agents`),
    '',
    '',
    '',
    '',
    '',
    pc.bold(String(report.total.messageCount)),
    pc.bold(formatTokens(totalTokens(report.total.counts))),
    pc.bold(pc.green(formatUsd(report.total.cost))),
  ]);

  return table.toString();
}

/**
 * Rend le tableau des skills : ce que chaque skill a réellement coûté, et le PIPELINE dont il
 * fait partie (la racine de sa chaîne d'invocation).
 *
 * Un même skill peut apparaître deux fois avec deux pipelines différents : `/epct` lancé seul
 * et `/epct` lancé par `/epct-sexy` ne sont pas le même usage, et les fusionner effacerait
 * précisément l'information recherchée.
 */
export function renderSkillsTable(report: SkillReport): string {
  const table = new Table({
    head: ['Skill', 'Pipeline', 'Modèles', 'Msgs', 'Tokens', 'Coût'].map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });

  for (const row of report.rows) {
    table.push([
      truncate(row.skill, 28),
      row.rootSkill === row.skill ? pc.dim('—') : truncate(row.rootSkill, 22),
      row.models.map(shortModel).join(', ') || '—',
      row.messageCount,
      formatTokens(totalTokens(row.counts)),
      pc.green(formatUsd(row.cost)),
    ]);
  }

  const t = report.total;
  table.push([
    pc.bold(`${report.rows.length} skills`),
    '',
    '',
    pc.bold(String(t.messageCount)),
    pc.bold(formatTokens(totalTokens(t.counts))),
    pc.bold(pc.green(formatUsd(t.cost))),
  ]);

  return table.toString();
}

/** Rend le tableau des pipelines (skills racines), vue repliée du rapport de skills. */
export function renderPipelinesTable(report: SkillReport): string {
  const table = new Table({
    head: ['Pipeline', 'Msgs', 'Tokens', 'Coût'].map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });
  for (const row of report.pipelines) {
    table.push([
      truncate(row.key, 32),
      row.messageCount,
      formatTokens(totalTokens(row.counts)),
      pc.green(formatUsd(row.cost)),
    ]);
  }
  return table.toString();
}

/**
 * Rend le tableau des outils. Aucune colonne de coût : un outil ne se facture pas, il INJECTE
 * du contexte que les requêtes suivantes paieront. La colonne « Contexte » est une ESTIMATION
 * dérivée du nombre de caractères réellement mesuré, d'où le « ≈ » de son en-tête.
 */
export function renderToolsTable(report: ToolReport): string {
  const table = new Table({
    head: ['Outil', 'Serveur', 'Skill', 'Appels', 'Err.', '≈ Contexte', 'Img'].map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });

  for (const row of report.rows) {
    table.push([
      truncate(row.tool, 38),
      truncate(row.server, 20),
      truncate(row.skill, 18),
      row.callCount,
      row.errorCount === 0 ? pc.dim('0') : pc.yellow(String(row.errorCount)),
      formatTokens(estimateTokensFromChars(row.resultChars)),
      row.resultImages === 0 ? pc.dim('—') : String(row.resultImages),
    ]);
  }

  const t = report.total;
  table.push([
    pc.bold(`${report.rows.length} outils`),
    '',
    '',
    pc.bold(String(t.callCount)),
    pc.bold(String(t.errorCount)),
    pc.bold(formatTokens(estimateTokensFromChars(t.resultChars))),
    pc.bold(String(t.resultImages)),
  ]);

  return table.toString();
}

/** Rend le tableau replié par serveur (un serveur MCP, ou `builtin`). */
export function renderServersTable(report: ToolReport): string {
  const table = new Table({
    head: ['Serveur', 'Appels', 'Err.', '≈ Contexte', 'Img'].map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });
  for (const row of report.servers) {
    table.push([
      truncate(row.server, 28),
      row.callCount,
      row.errorCount === 0 ? pc.dim('0') : pc.yellow(String(row.errorCount)),
      formatTokens(estimateTokensFromChars(row.resultChars)),
      row.resultImages === 0 ? pc.dim('—') : String(row.resultImages),
    ]);
  }
  return table.toString();
}

/**
 * Construit une barre de progression textuelle (blocs pleins/vides) pour un pourcentage donné.
 * @param percent pourcentage (0–100) ; les valeurs hors bornes sont ramenées dans l'intervalle.
 * @param width largeur de la barre en caractères.
 */
export function progressBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `${'▓'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}
