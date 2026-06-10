import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ClaudeEvent } from '../types/claude-events.js';
import type { PricingResolver } from '../pricing/pricing-loader.js';
import { costOf } from '../pricing/cost-model.js';
import { readJsonlFromLine, walkJsonlFiles } from '../parser/jsonl-parser.js';
import { pathToSlug, subagentsDirForTranscript } from '../parser/session-path.js';
import { aggregateUsageByModel } from '../report/usage-aggregation.js';

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

/** Liste les transcripts de sous-agents d'une session à partir du chemin principal. */
function subagentFiles(mainTranscript: string): string[] {
  const subagentsDir = subagentsDirForTranscript(mainTranscript);
  return existsSync(subagentsDir) ? walkJsonlFiles(subagentsDir) : [];
}

/** Itère les events d'une liste de fichiers, en ignorant ceux qui deviennent illisibles. */
function* iterEvents(files: string[]): Generator<ClaudeEvent> {
  for (const file of files) {
    let events: Array<{ event: ClaudeEvent }>;
    try {
      events = readJsonlFromLine(file, 0).events;
    } catch {
      continue; // fichier disparu/illisible : on l'ignore (comme l'ingestion)
    }
    for (const { event } of events) {
      yield event;
    }
  }
}

/**
 * Calcule le coût RÉEL de la session (transcript principal + sous-agents, cache inclus),
 * au tarif de notre grille, par modèle. Renvoie `null` en cas d'échec (l'appelant retombe
 * alors sur le chiffre natif de Claude Code).
 *
 * Aucune base de données n'est touchée (hot path du statusline). Le coût est recalculé à
 * chaque appel : ~100 ms sur la plus grosse session, bien en deçà du budget de 300 ms.
 */
export function computeSessionCost(params: SessionCostParams): number | null {
  const main = resolveMainTranscript(params);
  if (!main) {
    return null;
  }
  try {
    const { byModel } = aggregateUsageByModel(iterEvents([main, ...subagentFiles(main)]));
    let cost = 0;
    for (const [model, counts] of byModel) {
      cost += costOf(counts, params.resolver.resolve(model).pricing);
    }
    return cost;
  } catch {
    return null;
  }
}
