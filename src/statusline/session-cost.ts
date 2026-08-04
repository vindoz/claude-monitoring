import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { PricingResolver } from '../pricing/pricing-loader.js';
import { costOf, totalTokens, type UsageCounts } from '../pricing/cost-model.js';
import { walkJsonlFiles } from '../parser/jsonl-parser.js';
import { agentIdFromPath, pathToSlug, subagentsDirForTranscript } from '../parser/session-path.js';
import { aggregateFilesCached, mergeByModel, type FileUsage } from './usage-cache.js';

/** Paramètres de calcul du coût complet d'une session pour le statusline. */
export interface SessionCostParams {
  /** Chemin du transcript principal (fourni par Claude Code sur stdin). */
  transcriptPath?: string;
  /** Identifiant de session (repli pour reconstruire le chemin). */
  sessionId?: string;
  /** Répertoire courant (résolution d'un transcriptPath relatif + repli). */
  cwd?: string;
  /** Répertoire des transcripts (repli). */
  projectsDir: string;
  /** Résolveur de tarif. */
  resolver: PricingResolver;
  /** Cache d'agrégation par fichier ; `null` pour recalculer systématiquement. */
  cachePath?: string | null;
}

/** Consommation d'une session : coût complet et sous-agents rencontrés. */
export interface SessionUsage {
  /** Coût réel de la session (principal + sous-agents, cache inclus), au tarif de la grille. */
  cost: number;
  /** Nombre de sous-agents de la session. */
  agentCount: number;
  /** Nombre d'agents par modèle dominant, du plus fréquent au moins fréquent. */
  agentsByModel: Array<{ model: string; count: number }>;
}

/**
 * Localise le transcript principal : `transcript_path` (résolu en absolu), sinon reconstruction
 * `<projectsDir>/<slug(cwd)>/<sessionId>.jsonl`.
 */
function resolveMainTranscript(params: SessionCostParams): string | null {
  if (params.transcriptPath) {
    const abs = isAbsolute(params.transcriptPath)
      ? params.transcriptPath
      : resolve(params.cwd ?? process.cwd(), params.transcriptPath);
    if (existsSync(abs)) {
      return abs;
    }
  }
  if (params.sessionId && params.cwd) {
    const candidate = join(params.projectsDir, pathToSlug(params.cwd), `${params.sessionId}.jsonl`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Liste les transcripts de SOUS-AGENTS d'une session. Le filtre sur `agentIdFromPath` est
 * nécessaire : le répertoire `subagents/` contient aussi les journaux de workflow, qui ne sont
 * pas des agents et fausseraient leur décompte.
 */
function subagentFiles(mainTranscript: string): string[] {
  const subagentsDir = subagentsDirForTranscript(mainTranscript);
  if (!existsSync(subagentsDir)) {
    return [];
  }
  return walkJsonlFiles(subagentsDir).filter((file) => agentIdFromPath(file) !== null);
}

/** Modèle dominant d'un fichier d'agent : celui qui pèse le plus de tokens. */
function dominantModel(byModel: Map<string, UsageCounts>): string | null {
  let best: string | null = null;
  let bestTokens = -1;
  for (const [model, counts] of byModel) {
    const tokens = totalTokens(counts);
    if (tokens > bestTokens) {
      best = model;
      bestTokens = tokens;
    }
  }
  return best;
}

/** Compte les agents par modèle dominant, du plus fréquent au moins fréquent. */
function countAgentsByModel(agentUsages: FileUsage[]): Array<{ model: string; count: number }> {
  const counts = new Map<string, number>();
  for (const usage of agentUsages) {
    const model = dominantModel(usage.byModel);
    if (model !== null) {
      counts.set(model, (counts.get(model) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
}

/**
 * Calcule la consommation RÉELLE de la session (transcript principal + sous-agents, cache
 * inclus), au tarif de notre grille, par modèle, et relève au passage les sous-agents et le
 * modèle de chacun. Renvoie `null` en cas d'échec (l'appelant retombe alors sur le chiffre
 * natif de Claude Code).
 *
 * Aucune base de données n'est touchée (hot path du statusline) ; l'agrégat de chaque fichier
 * déjà lu est mémorisé (cf. `usage-cache`), ce qui ramène le recalcul aux seuls transcripts
 * modifiés depuis l'affichage précédent.
 */
export function computeSessionUsage(params: SessionCostParams): SessionUsage | null {
  const main = resolveMainTranscript(params);
  if (!main) {
    return null;
  }
  try {
    const cachePath = params.cachePath === undefined ? null : params.cachePath;
    const agentFiles = subagentFiles(main);
    const usages = aggregateFilesCached([main, ...agentFiles], cachePath);

    let cost = 0;
    for (const [model, counts] of mergeByModel(usages)) {
      cost += costOf(counts, params.resolver.resolve(model).pricing);
    }

    const agentUsages = usages.filter((usage) => usage.path !== main);
    return {
      cost,
      agentCount: agentUsages.length,
      agentsByModel: countAgentsByModel(agentUsages),
    };
  } catch {
    return null;
  }
}

/** Coût complet seul — conservé pour les appelants qui n'ont pas besoin du détail des agents. */
export function computeSessionCost(params: SessionCostParams): number | null {
  return computeSessionUsage(params)?.cost ?? null;
}
