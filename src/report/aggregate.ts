import type {
  AgentMetaRow,
  AgentUsageRow,
  DayProjectUsageRow,
  DimensionUsageRow,
  SessionMeta,
  SkillEdgeRow,
  SkillUsageRow,
  ToolUsageRow,
} from '../db/queries.js';
import type { PricingResolver } from '../pricing/pricing-loader.js';
import { agentTitle } from '../parser/session-path.js';
import { addUsage, costOf, totalTokens, zeroUsage, type UsageCounts } from '../pricing/cost-model.js';

/** Ligne d'un rapport par dimension, avec coût calculé. */
export interface CostedRow {
  key: string;
  messageCount: number;
  counts: UsageCounts;
  cost: number;
}

/** Rapport agrégé par dimension. */
export interface DimensionReport {
  rows: CostedRow[];
  total: CostedRow;
  /** Modèles non tarifés ayant pourtant consommé des tokens (signalement). */
  unknownModels: string[];
}

/** Crée une ligne de coût vide pour une clé donnée. */
function emptyRow(key: string): CostedRow {
  return { key, messageCount: 0, counts: zeroUsage(), cost: 0 };
}

/**
 * Résout le tarif d'une ligne d'usage, signale un éventuel modèle non tarifé et accumule
 * la ligne dans le total. Mutualise la logique commune aux deux agrégations.
 * @returns le coût calculé de la ligne.
 */
function resolveAndAccumulate(
  row: DimensionUsageRow,
  resolver: PricingResolver,
  total: CostedRow,
  unknownModels: Set<string>,
): number {
  const resolved = resolver.resolve(row.model);
  if (resolved.match === 'unknown' && totalTokens(row.counts) > 0) {
    unknownModels.add(resolved.canonical);
  }
  const cost = costOf(row.counts, resolved.pricing);
  total.messageCount += row.messageCount;
  total.counts = addUsage(total.counts, row.counts);
  total.cost += cost;
  return cost;
}

/**
 * Agrège des lignes d'usage (par clé × modèle) en un rapport par dimension, coût calculé.
 * Le coût est évalué par modèle (les tarifs diffèrent) avant d'être sommé par clé.
 */
export function aggregateDimension(
  rows: DimensionUsageRow[],
  resolver: PricingResolver,
): DimensionReport {
  const byKey = new Map<string, CostedRow>();
  const total = emptyRow('TOTAL');
  const unknownModels = new Set<string>();

  for (const row of rows) {
    const cost = resolveAndAccumulate(row, resolver, total, unknownModels);
    const current = byKey.get(row.key) ?? emptyRow(row.key);
    current.messageCount += row.messageCount;
    current.counts = addUsage(current.counts, row.counts);
    current.cost += cost;
    byKey.set(row.key, current);
  }

  const sorted = [...byKey.values()].sort((a, b) => b.cost - a.cost);
  return { rows: sorted, total, unknownModels: [...unknownModels] };
}

/** Coût d'un projet sur un jour donné (brique du graphique empilé). */
export interface DayProjectCost {
  day: string;
  project: string;
  cost: number;
  messageCount: number;
}

/**
 * Calcule le coût par (jour, projet) à partir des lignes (jour, projet, modèle).
 * Le coût est évalué par modèle (les tarifs diffèrent) puis sommé sur le couple (jour, projet).
 */
export function aggregateDayProject(
  rows: DayProjectUsageRow[],
  resolver: PricingResolver,
): DayProjectCost[] {
  const byCell = new Map<string, DayProjectCost>();
  for (const row of rows) {
    const cost = costOf(row.counts, resolver.resolve(row.model).pricing);
    const cellKey = `${row.day} ${row.project}`;
    const cell = byCell.get(cellKey) ?? {
      day: row.day,
      project: row.project,
      cost: 0,
      messageCount: 0,
    };
    cell.cost += cost;
    cell.messageCount += row.messageCount;
    byCell.set(cellKey, cell);
  }
  return [...byCell.values()];
}

/** Ligne d'un rapport de sous-agents (métadonnées + modèles + coût). */
export interface AgentReportRow {
  meta: AgentMetaRow;
  /** Titre affichable (description, à défaut type, à défaut identifiant). */
  title: string;
  /** Modèles réellement utilisés par l'agent — c'est `message.model` du transcript. */
  models: string[];
  messageCount: number;
  counts: UsageCounts;
  cost: number;
}

/** Rapport de sous-agents. */
export interface AgentReport {
  rows: AgentReportRow[];
  total: CostedRow;
  unknownModels: string[];
}

/**
 * Combine l'usage par agent avec les métadonnées d'agent pour produire un rapport coûté,
 * trié par activité la plus récente.
 *
 * Les agents SANS consommation (transcript sans réponse d'assistant) sont conservés avec un
 * coût nul : ils ont bien existé, les masquer donnerait une vue incomplète des lancements.
 */
export function aggregateAgents(
  usageRows: AgentUsageRow[],
  metas: AgentMetaRow[],
  resolver: PricingResolver,
): AgentReport {
  const acc = new Map<
    string,
    { models: Set<string>; messageCount: number; counts: UsageCounts; cost: number }
  >();
  const total = emptyRow('TOTAL');
  const unknownModels = new Set<string>();

  for (const row of usageRows) {
    const cost = resolveAndAccumulate(
      { key: row.agentId, model: row.model, messageCount: row.messageCount, counts: row.counts },
      resolver,
      total,
      unknownModels,
    );
    const current = acc.get(row.agentId) ?? {
      models: new Set<string>(),
      messageCount: 0,
      counts: zeroUsage(),
      cost: 0,
    };
    current.models.add(row.model);
    current.messageCount += row.messageCount;
    current.counts = addUsage(current.counts, row.counts);
    current.cost += cost;
    acc.set(row.agentId, current);
  }

  const metaById = new Map(metas.map((m) => [m.agentId, m]));
  // Un agent orphelin d'usage doit rester listé ; un usage orphelin de méta ne doit pas
  // disparaître silencieusement du total affiché.
  const agentIds = new Set([...metaById.keys(), ...acc.keys()]);

  const rows: AgentReportRow[] = [];
  for (const agentId of agentIds) {
    const usage = acc.get(agentId);
    const meta: AgentMetaRow = metaById.get(agentId) ?? {
      agentId,
      sessionId: '',
      projectSlug: '',
      agentType: null,
      description: null,
      parentAgentId: null,
      spawnDepth: null,
      firstTs: null,
      lastTs: null,
    };
    rows.push({
      meta,
      title: agentTitle(
        { description: meta.description ?? undefined, agentType: meta.agentType ?? undefined },
        agentId,
      ),
      models: usage ? [...usage.models].sort() : [],
      messageCount: usage?.messageCount ?? 0,
      counts: usage?.counts ?? zeroUsage(),
      cost: usage?.cost ?? 0,
    });
  }
  rows.sort((a, b) => (b.meta.lastTs ?? 0) - (a.meta.lastTs ?? 0));

  return { rows, total, unknownModels: [...unknownModels] };
}

/**
 * Restreint les métadonnées d'agents à ceux ayant consommé dans la période demandée.
 *
 * La table `agents` n'a pas de grain journalier : seul `agent_rollup` sait dater. Sans cette
 * restriction, un agent extérieur à la période sélectionnée s'afficherait quand même, avec un
 * coût nul. Hors période sélectionnée, on conserve tout le monde — y compris les agents sans
 * consommation, qui ont bien été lancés.
 */
export function agentsInPeriod(
  metas: AgentMetaRow[],
  usageRows: AgentUsageRow[],
  periodSelected: boolean,
): AgentMetaRow[] {
  if (!periodSelected) {
    return metas;
  }
  const withUsage = new Set(usageRows.map((row) => row.agentId));
  return metas.filter((meta) => withUsage.has(meta.agentId));
}

/** Regroupe les agents d'un rapport par session parente, dans l'ordre du rapport. */
export function groupAgentsBySession(report: AgentReport): Map<string, AgentReportRow[]> {
  const bySession = new Map<string, AgentReportRow[]>();
  for (const row of report.rows) {
    const list = bySession.get(row.meta.sessionId);
    if (list) {
      list.push(row);
    } else {
      bySession.set(row.meta.sessionId, [row]);
    }
  }
  return bySession;
}

/** Ligne d'un rapport de sessions (métadonnées + coût). */
export interface SessionReportRow {
  meta: SessionMeta;
  models: string[];
  messageCount: number;
  counts: UsageCounts;
  cost: number;
}

/** Rapport de sessions. */
export interface SessionReport {
  rows: SessionReportRow[];
  total: CostedRow;
  unknownModels: string[];
}

/**
 * Combine l'usage par session (clé = sessionId) avec les métadonnées de session pour produire
 * un rapport coûté, trié par activité la plus récente.
 */
export function aggregateSessions(
  usageRows: DimensionUsageRow[],
  metas: SessionMeta[],
  resolver: PricingResolver,
): SessionReport {
  const metaById = new Map(metas.map((m) => [m.sessionId, m]));
  const acc = new Map<
    string,
    { models: Set<string>; messageCount: number; counts: UsageCounts; cost: number }
  >();
  const total = emptyRow('TOTAL');
  const unknownModels = new Set<string>();

  for (const row of usageRows) {
    const cost = resolveAndAccumulate(row, resolver, total, unknownModels);
    const current = acc.get(row.key) ?? {
      models: new Set<string>(),
      messageCount: 0,
      counts: zeroUsage(),
      cost: 0,
    };
    current.models.add(row.model);
    current.messageCount += row.messageCount;
    current.counts = addUsage(current.counts, row.counts);
    current.cost += cost;
    acc.set(row.key, current);
  }

  const rows: SessionReportRow[] = [];
  for (const [sessionId, agg] of acc) {
    const meta = metaById.get(sessionId) ?? {
      sessionId,
      projectSlug: '',
      cwd: null,
      title: null,
      firstTs: null,
      lastTs: null,
      gitBranch: null,
    };
    rows.push({
      meta,
      models: [...agg.models].sort(),
      messageCount: agg.messageCount,
      counts: agg.counts,
      cost: agg.cost,
    });
  }
  rows.sort((a, b) => (b.meta.lastTs ?? 0) - (a.meta.lastTs ?? 0));

  return { rows, total, unknownModels: [...unknownModels] };
}

/** Ligne d'un rapport de skills : le skill, son pipeline, et ce qu'il a coûté. */
export interface SkillReportRow {
  /** Skill auquel les messages sont imputés (`attributionSkill`), ou `(hors skill)`. */
  skill: string;
  /** Racine de la chaîne d'invocation — c'est ce qu'on appelle le « pipeline ». */
  rootSkill: string;
  /** Modèles réellement utilisés sous ce skill. */
  models: string[];
  messageCount: number;
  counts: UsageCounts;
  cost: number;
}

/** Rapport de consommation par skill, avec la vue agrégée par pipeline. */
export interface SkillReport {
  /** Une ligne par couple (skill, pipeline) : un même skill peut avoir deux racines. */
  rows: SkillReportRow[];
  /** Le même total, regroupé par skill racine. */
  pipelines: CostedRow[];
  total: CostedRow;
  unknownModels: string[];
}

/** Profondeur maximale de remontée d'une chaîne de skills (garde-fou de dernier recours). */
const MAX_SKILL_DEPTH = 32;

/** Indexe les arêtes par session : `session → (enfant → parent)`. */
export function indexSkillEdges(edges: SkillEdgeRow[]): Map<string, Map<string, string>> {
  const bySession = new Map<string, Map<string, string>>();
  for (const edge of edges) {
    const parents = bySession.get(edge.sessionId) ?? new Map<string, string>();
    parents.set(edge.childSkill, edge.parentSkill);
    bySession.set(edge.sessionId, parents);
  }
  return bySession;
}

/**
 * Remonte la chaîne d'invocation jusqu'à son skill racine.
 *
 * Deux gardes, parce que les arêtes viennent de transcripts réels et non d'un modèle
 * théorique : un ensemble de skills déjà visités arrête tout cycle, et un plafond de
 * profondeur borne le cas pathologique qu'il n'aurait pas attrapé. Sans arête, un skill est
 * sa propre racine — c'est le cas d'une invocation depuis la boucle principale.
 */
export function resolveRootSkill(parents: Map<string, string> | undefined, skill: string): string {
  if (!parents) {
    return skill;
  }
  const visited = new Set<string>([skill]);
  let current = skill;
  for (let depth = 0; depth < MAX_SKILL_DEPTH; depth += 1) {
    const parent = parents.get(current);
    if (parent === undefined || visited.has(parent)) {
      return current;
    }
    visited.add(parent);
    current = parent;
  }
  return current;
}

/**
 * Combine l'usage par skill avec les arêtes de filiation pour produire un rapport coûté.
 *
 * La racine se résout SESSION PAR SESSION : un même skill peut être lancé directement dans
 * une session et depuis un autre skill dans une autre ; agréger d'abord et résoudre ensuite
 * mélangerait les deux.
 */
export function aggregateSkills(
  usageRows: SkillUsageRow[],
  edges: SkillEdgeRow[],
  resolver: PricingResolver,
): SkillReport {
  const edgesBySession = indexSkillEdges(edges);
  const acc = new Map<
    string,
    { skill: string; rootSkill: string; models: Set<string>; messageCount: number; counts: UsageCounts; cost: number }
  >();
  const byPipeline = new Map<string, CostedRow>();
  const total = emptyRow('TOTAL');
  const unknownModels = new Set<string>();

  for (const row of usageRows) {
    const rootSkill = resolveRootSkill(edgesBySession.get(row.sessionId), row.skill);
    const cost = resolveAndAccumulate(
      { key: row.skill, model: row.model, messageCount: row.messageCount, counts: row.counts },
      resolver,
      total,
      unknownModels,
    );

    const key = `${row.skill}\u0000${rootSkill}`;
    const current = acc.get(key) ?? {
      skill: row.skill,
      rootSkill,
      models: new Set<string>(),
      messageCount: 0,
      counts: zeroUsage(),
      cost: 0,
    };
    current.models.add(row.model);
    current.messageCount += row.messageCount;
    current.counts = addUsage(current.counts, row.counts);
    current.cost += cost;
    acc.set(key, current);

    const pipeline = byPipeline.get(rootSkill) ?? emptyRow(rootSkill);
    pipeline.messageCount += row.messageCount;
    pipeline.counts = addUsage(pipeline.counts, row.counts);
    pipeline.cost += cost;
    byPipeline.set(rootSkill, pipeline);
  }

  const rows: SkillReportRow[] = [...acc.values()]
    .map((entry) => ({
      skill: entry.skill,
      rootSkill: entry.rootSkill,
      models: [...entry.models].sort(),
      messageCount: entry.messageCount,
      counts: entry.counts,
      cost: entry.cost,
    }))
    .sort((a, b) => b.cost - a.cost);

  const pipelines = [...byPipeline.values()].sort((a, b) => b.cost - a.cost);
  return { rows, pipelines, total, unknownModels: [...unknownModels] };
}

/** Compteurs d'un outil : ce qu'il a été appelé, et ce qu'il a injecté dans le contexte. */
export interface ToolCounters {
  callCount: number;
  errorCount: number;
  /** Caractères de texte injectés par les résultats (images exclues). */
  resultChars: number;
  resultImages: number;
}

/** Ligne d'un rapport d'outils. */
export interface ToolReportRow extends ToolCounters {
  tool: string;
  server: string;
  skill: string;
}

/** Agrégat d'un serveur (un serveur MCP, ou `builtin` pour les outils natifs). */
export interface ServerReportRow extends ToolCounters {
  server: string;
}

/** Rapport d'usage des outils. */
export interface ToolReport {
  rows: ToolReportRow[];
  servers: ServerReportRow[];
  total: ToolCounters;
}

/** Compteurs d'outil à zéro (élément neutre des agrégations). */
function zeroToolCounters(): ToolCounters {
  return { callCount: 0, errorCount: 0, resultChars: 0, resultImages: 0 };
}

/** Ajoute les compteurs d'une ligne à un accumulateur. */
function addToolCounters(target: ToolCounters, row: ToolCounters): void {
  target.callCount += row.callCount;
  target.errorCount += row.errorCount;
  target.resultChars += row.resultChars;
  target.resultImages += row.resultImages;
}

/**
 * Nombre de tokens qu'un volume de caractères représente, en ordre de grandeur.
 *
 * C'est une ESTIMATION, et elle n'est jamais stockée : seul le nombre de caractères est un
 * fait mesuré. Le ratio de 4 caractères par token est la règle empirique usuelle sur du texte
 * technique ; il ne vaut ni pour du base64 (d'où l'exclusion des images) ni au caractère près.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.round(chars / 4);
}

/**
 * Agrège les appels d'outils par (outil, skill) et par serveur.
 *
 * Aucun coût n'est calculé : un outil ne se facture pas, il INJECTE du contexte que les
 * requêtes suivantes paieront. Confondre les deux donnerait un chiffre faux et rassurant.
 */
export function aggregateTools(usageRows: ToolUsageRow[]): ToolReport {
  const byServer = new Map<string, ServerReportRow>();
  const total = zeroToolCounters();
  const rows: ToolReportRow[] = [];

  for (const row of usageRows) {
    rows.push({
      tool: row.tool,
      server: row.server,
      skill: row.skill,
      callCount: row.callCount,
      errorCount: row.errorCount,
      resultChars: row.resultChars,
      resultImages: row.resultImages,
    });
    addToolCounters(total, row);
    const server = byServer.get(row.server) ?? { server: row.server, ...zeroToolCounters() };
    addToolCounters(server, row);
    byServer.set(row.server, server);
  }

  rows.sort((a, b) => b.resultChars - a.resultChars || b.callCount - a.callCount);
  const servers = [...byServer.values()].sort(
    (a, b) => b.resultChars - a.resultChars || b.callCount - a.callCount,
  );
  return { rows, servers, total };
}
