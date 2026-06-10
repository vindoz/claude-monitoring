import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Résolution centralisée des chemins utilisés par l'outil.
 * Tous les chemins sont surchargeables via variables d'environnement (portabilité + tests).
 */

/** Répertoire racine de configuration de Claude Code (`~/.claude` par défaut). */
export function claudeHome(): string {
  return process.env.CCMON_CLAUDE_HOME ?? join(homedir(), '.claude');
}

/** Répertoire contenant les transcripts de session, par projet. */
export function projectsDir(): string {
  return process.env.CCMON_PROJECTS_DIR ?? join(claudeHome(), 'projects');
}

/** Chemin du fichier de base de données SQLite (hors du dépôt, dans `~/.claude`). */
export function databasePath(): string {
  return process.env.CCMON_DB ?? join(claudeHome(), 'claude-monitoring.db');
}

/** Chemin du fichier `settings.json` de Claude Code. */
export function settingsPath(): string {
  return join(claudeHome(), 'settings.json');
}

/** Répertoire des skills utilisateur de Claude Code. */
export function skillsDir(): string {
  return join(claudeHome(), 'skills');
}

/**
 * Chemin d'un éventuel fichier d'override de pricing utilisateur.
 * Priorité : variable `CCMON_PRICING`, sinon `~/.claude/claude-monitoring.pricing.json`.
 */
export function userPricingPath(): string {
  return process.env.CCMON_PRICING ?? join(claudeHome(), 'claude-monitoring.pricing.json');
}
