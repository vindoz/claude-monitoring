import { readFileSync } from 'node:fs';
import { relative, sep, basename, dirname, join } from 'node:path';
import type { AgentMeta } from '../types/claude-events.js';

/** Nom du répertoire contenant les transcripts de sous-agents d'une session. */
export const SUBAGENTS_DIRNAME = 'subagents';

/** Motif de nommage d'un transcript de sous-agent : `agent-<id>.jsonl`. */
const AGENT_FILE_PATTERN = /^agent-(.+)\.jsonl$/;

/**
 * Décomposition d'un chemin de transcript en informations de session.
 */
export interface SessionPathInfo {
  /** Slug du projet (1er répertoire sous `projects/`), ex. `-home-user-projets-demo`. */
  projectSlug: string;
  /** Identifiant de la session parente. */
  sessionId: string;
  /** Vrai si le fichier est un transcript de sous-agent (`<session>/subagents/**`). */
  isSubagent: boolean;
  /**
   * Identifiant de l'agent, ou `null` si le fichier n'est pas un transcript d'agent.
   * `isSubagent` ne suffit PAS à le déduire : il est vrai pour tout chemin imbriqué sous un
   * répertoire de session, y compris des fichiers qui ne sont pas des agents (par exemple
   * `subagents/workflows/wf_<id>/journal.jsonl`).
   */
  agentId: string | null;
}

/**
 * Décompose le chemin d'un transcript JSONL relatif au répertoire `projects/`.
 *
 * Deux dispositions existent :
 * - session principale : `<slug>/<sessionId>.jsonl` ;
 * - transcript de sous-agent : `<slug>/<sessionId>/subagents/**​/agent-*.jsonl`.
 *
 * Dans les deux cas, le fichier est rattaché à la même session parente `<sessionId>`,
 * afin que les coûts des agents soient agrégés avec leur session d'origine.
 *
 * @returns les informations de session, ou `null` si le chemin n'est pas reconnu.
 */
export function parseSessionPath(filePath: string, projectsDir: string): SessionPathInfo | null {
  const rel = relative(projectsDir, filePath);
  if (rel.startsWith('..')) {
    return null;
  }
  const segments = rel.split(sep);
  if (segments.length < 2) {
    return null;
  }
  const projectSlug = segments[0];
  const second = segments[1];

  // Cas 1 : enfant direct = `<sessionId>.jsonl` → session principale.
  if (segments.length === 2 && second.endsWith('.jsonl')) {
    return {
      projectSlug,
      sessionId: basename(second, '.jsonl'),
      isSubagent: false,
      agentId: null,
    };
  }

  // Cas 2 : répertoire de session contenant des sous-agents → `<sessionId>` est le 2e segment.
  return {
    projectSlug,
    sessionId: second,
    isSubagent: true,
    agentId: agentIdFromPath(filePath),
  };
}

/**
 * Extrait l'identifiant d'agent d'un chemin de transcript, ou `null` si le fichier n'est pas
 * un transcript d'agent.
 *
 * Les DEUX conditions sont exigées, car le répertoire d'une session contient d'autres fichiers
 * `.jsonl` : le chemin doit traverser un répertoire `subagents`, ET le nom de fichier doit
 * suivre `agent-<id>.jsonl`. Sans cette garde, le `journal.jsonl` d'un workflow (présent sous
 * `subagents/workflows/`) serait ingéré comme un agent nommé `journal`, en collision de clé
 * primaire entre deux workflows d'une même session.
 */
export function agentIdFromPath(filePath: string): string | null {
  const matched = AGENT_FILE_PATTERN.exec(basename(filePath));
  if (!matched) {
    return null;
  }
  const parents = dirname(filePath).split(sep);
  return parents.includes(SUBAGENTS_DIRNAME) ? matched[1] : null;
}

/**
 * Chemin du fichier de métadonnées jumeau d'un transcript d'agent
 * (`agent-<id>.jsonl` → `agent-<id>.meta.json`).
 */
export function agentMetaPathFor(agentTranscript: string): string {
  return `${agentTranscript.replace(/\.jsonl$/, '')}.meta.json`;
}

/**
 * Lit les métadonnées d'un agent (titre, type, parent). Lecture tolérante, à l'image du parser
 * de transcripts : fichier absent, illisible ou JSON invalide renvoient `null` plutôt que de
 * faire échouer l'ingestion.
 */
export function readAgentMeta(agentTranscript: string): AgentMeta | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(agentMetaPathFor(agentTranscript), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as AgentMeta) : null;
  } catch {
    return null;
  }
}

/**
 * Titre affichable d'un agent. Replis successifs : la `description` du meta (absente pour les
 * agents de workflow), puis le type d'agent, puis l'identifiant — une ligne n'est jamais vide.
 */
export function agentTitle(meta: AgentMeta | null, agentId: string): string {
  return meta?.description || meta?.agentType || agentId;
}

/**
 * Convertit un chemin absolu de projet en slug, selon la convention de Claude Code
 * (chaque séparateur `/` devient `-`). Utilisé pour filtrer par `--project`.
 */
export function pathToSlug(absolutePath: string): string {
  return absolutePath.replace(/\//g, '-');
}

/**
 * Répertoire des sous-agents d'une session, à partir du chemin de son transcript principal
 * (`<…>/<sessionId>.jsonl` → `<…>/<sessionId>/subagents`). Source unique de la convention.
 */
export function subagentsDirForTranscript(mainTranscript: string): string {
  return join(mainTranscript.replace(/\.jsonl$/, ''), SUBAGENTS_DIRNAME);
}

/**
 * Produit un libellé de projet lisible.
 * Privilégie les deux derniers segments du `cwd` réel (issu des events) ;
 * à défaut, retombe sur le slug brut.
 */
export function prettyProject(projectSlug: string, cwd?: string | null): string {
  if (cwd && cwd.length > 0) {
    const parts = cwd.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return parts.slice(-2).join('/');
    }
    if (parts.length === 1) {
      return parts[0];
    }
  }
  return projectSlug;
}
