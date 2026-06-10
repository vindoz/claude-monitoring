import { relative, sep, basename } from 'node:path';

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
    };
  }

  // Cas 2 : répertoire de session contenant des sous-agents → `<sessionId>` est le 2e segment.
  return {
    projectSlug,
    sessionId: second,
    isSubagent: true,
  };
}

/**
 * Convertit un chemin absolu de projet en slug, selon la convention de Claude Code
 * (chaque séparateur `/` devient `-`). Utilisé pour filtrer par `--project`.
 */
export function pathToSlug(absolutePath: string): string {
  return absolutePath.replace(/\//g, '-');
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
