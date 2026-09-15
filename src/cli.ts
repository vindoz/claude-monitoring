#!/usr/bin/env node
import { Command } from 'commander';
import { writeErr } from './format/output.js';
import type { Dimension } from './db/queries.js';

/**
 * Les commandes sont importées dynamiquement dans leurs actions : ainsi `ccmon statusline`
 * (hot path appelé ~toutes les 300 ms) ne charge pas les modules de base de données
 * (better-sqlite3, natif) tirés par `ingest`/`sessions`/`summary`/`serve`.
 */

/** Convertit une option numérique de ligne de commande. */
function toInt(value: string): number {
  return Number.parseInt(value, 10);
}

const program = new Command();
program
  .name('ccmon')
  .description('Monitoring de Claude Code : sessions, coûts et statusline')
  .version('0.1.0');

program
  .command('ingest')
  .description('Ingestion incrémentale des transcripts vers la base SQLite')
  .option('--force', 'réindexe intégralement tous les fichiers')
  .option('--db <path>', 'chemin de la base SQLite')
  .option('--projects-dir <path>', 'répertoire des transcripts Claude Code')
  .option('-q, --quiet', 'sortie minimale')
  .action(async (opts) => {
    const { runIngest } = await import('./commands/ingest.js');
    runIngest({ force: opts.force, db: opts.db, projectsDir: opts.projectsDir, quiet: opts.quiet });
  });

program
  .command('sessions')
  .description('Liste les sessions Claude Code et leur coût agrégé')
  .option('--project <slug>', 'filtre par slug de projet')
  .option('--since <date>', 'jour minimum inclus (YYYY-MM-DD)')
  .option('--until <date>', 'jour maximum inclus (YYYY-MM-DD)')
  .option('--limit <n>', 'nombre maximum de sessions affichées', toInt, 50)
  .option('--json', 'sortie au format JSON')
  .option('--no-ingest', 'ne pas (ré)ingérer avant affichage')
  .option('--db <path>', 'chemin de la base SQLite')
  .option('--projects-dir <path>', 'répertoire des transcripts Claude Code')
  .option('--pricing <path>', 'fichier de pricing override')
  .option('-q, --quiet', "masque le bilan d'ingestion")
  .action(async (opts) => {
    const { runSessions } = await import('./commands/sessions.js');
    runSessions({
      project: opts.project,
      since: opts.since,
      until: opts.until,
      limit: opts.limit,
      json: opts.json,
      noIngest: opts.ingest === false,
      db: opts.db,
      projectsDir: opts.projectsDir,
      pricing: opts.pricing,
      quiet: opts.quiet,
    });
  });

program
  .command('agents')
  .description('Liste les sous-agents, le modèle qu’ils ont utilisé et leur coût')
  .option('--project <slug>', 'filtre par slug de projet')
  .option('--session <id>', 'filtre par session (identifiant complet ou préfixe)')
  .option('--since <date>', 'jour minimum inclus (YYYY-MM-DD)')
  .option('--until <date>', 'jour maximum inclus (YYYY-MM-DD)')
  .option('--limit <n>', 'nombre maximum d’agents affichés', toInt, 50)
  .option('--json', 'sortie au format JSON')
  .option('--no-ingest', 'ne pas (ré)ingérer avant affichage')
  .option('--db <path>', 'chemin de la base SQLite')
  .option('--projects-dir <path>', 'répertoire des transcripts Claude Code')
  .option('--pricing <path>', 'fichier de pricing override')
  .option('-q, --quiet', "masque le bilan d'ingestion")
  .action(async (opts) => {
    const { runAgents } = await import('./commands/agents.js');
    runAgents({
      project: opts.project,
      session: opts.session,
      since: opts.since,
      until: opts.until,
      limit: opts.limit,
      json: opts.json,
      noIngest: opts.ingest === false,
      db: opts.db,
      projectsDir: opts.projectsDir,
      pricing: opts.pricing,
      quiet: opts.quiet,
    });
  });

program
  .command('skills')
  .description('Liste ce que chaque skill a coûté, et le pipeline dont il relève')
  .option('--project <slug>', 'filtre par slug de projet')
  .option('--pipeline <skill>', 'filtre par pipeline (skill racine de la chaîne)')
  .option('--since <date>', 'jour minimum inclus (YYYY-MM-DD)')
  .option('--until <date>', 'jour maximum inclus (YYYY-MM-DD)')
  .option('--limit <n>', 'nombre maximum de skills affichés', toInt, 50)
  .option('--json', 'sortie au format JSON')
  .option('--no-ingest', 'ne pas (ré)ingérer avant affichage')
  .option('--db <path>', 'chemin de la base SQLite')
  .option('--projects-dir <path>', 'répertoire des transcripts Claude Code')
  .option('--pricing <path>', 'fichier de pricing override')
  .option('-q, --quiet', "masque le bilan d'ingestion")
  .action(async (opts) => {
    const { runSkills } = await import('./commands/skills.js');
    runSkills({
      project: opts.project,
      pipeline: opts.pipeline,
      since: opts.since,
      until: opts.until,
      limit: opts.limit,
      json: opts.json,
      noIngest: opts.ingest === false,
      db: opts.db,
      projectsDir: opts.projectsDir,
      pricing: opts.pricing,
      quiet: opts.quiet,
    });
  });

program
  .command('tools')
  .description('Liste les appels d’outils et le contexte qu’ils injectent (dont les serveurs MCP)')
  .option('--project <slug>', 'filtre par slug de projet')
  .option('--server <nom>', 'filtre par serveur (jira, mcp:jira, builtin)')
  .option('--mcp', 'ne garde que les outils exposés par un serveur MCP')
  .option('--skill <nom>', 'ne garde que les appels passés sous ce skill')
  .option('--since <date>', 'jour minimum inclus (YYYY-MM-DD)')
  .option('--until <date>', 'jour maximum inclus (YYYY-MM-DD)')
  .option('--limit <n>', 'nombre maximum d’outils affichés', toInt, 50)
  .option('--json', 'sortie au format JSON')
  .option('--no-ingest', 'ne pas (ré)ingérer avant affichage')
  .option('--db <path>', 'chemin de la base SQLite')
  .option('--projects-dir <path>', 'répertoire des transcripts Claude Code')
  .option('-q, --quiet', "masque le bilan d'ingestion")
  .action(async (opts) => {
    const { runTools } = await import('./commands/tools.js');
    runTools({
      project: opts.project,
      server: opts.server,
      mcp: opts.mcp,
      skill: opts.skill,
      since: opts.since,
      until: opts.until,
      limit: opts.limit,
      json: opts.json,
      noIngest: opts.ingest === false,
      db: opts.db,
      projectsDir: opts.projectsDir,
      quiet: opts.quiet,
    });
  });

program
  .command('summary')
  .description('Agrège les coûts par projet, session, modèle ou jour')
  .requiredOption('--by <dimension>', 'project | session | model | day')
  .option('--project <slug>', 'filtre par slug de projet')
  .option('--since <date>', 'jour minimum inclus (YYYY-MM-DD)')
  .option('--until <date>', 'jour maximum inclus (YYYY-MM-DD)')
  .option('--model <id>', 'filtre par identifiant de modèle')
  .option('--limit <n>', 'nombre maximum de lignes affichées', toInt)
  .option('--json', 'sortie au format JSON')
  .option('--no-ingest', 'ne pas (ré)ingérer avant affichage')
  .option('--db <path>', 'chemin de la base SQLite')
  .option('--projects-dir <path>', 'répertoire des transcripts Claude Code')
  .option('--pricing <path>', 'fichier de pricing override')
  .option('-q, --quiet', "masque le bilan d'ingestion")
  .action(async (opts) => {
    const { runSummary } = await import('./commands/summary.js');
    runSummary({
      by: opts.by as Dimension,
      project: opts.project,
      since: opts.since,
      until: opts.until,
      model: opts.model,
      limit: opts.limit,
      json: opts.json,
      noIngest: opts.ingest === false,
      db: opts.db,
      projectsDir: opts.projectsDir,
      pricing: opts.pricing,
      quiet: opts.quiet,
    });
  });

program
  .command('statusline')
  .description('Statusline Claude Code : coût de la session et occupation du contexte (lit stdin)')
  .option('--format <format>', 'oneline | compact', 'oneline')
  .option('--no-color', 'désactive la couleur')
  .action(async (opts) => {
    const { runStatusline } = await import('./commands/statusline.js');
    await runStatusline({ format: opts.format, noColor: opts.color === false });
  });

program
  .command('serve')
  .description('Lance un tableau de bord web local (coûts par projet, modèle, jour + sessions)')
  .option('--port <n>', 'port d’écoute', toInt, 4757)
  .option('--host <host>', 'adresse d’écoute', '127.0.0.1')
  .option('--limit <n>', 'nombre de sessions affichées', toInt, 30)
  .option('--no-ingest', 'ne pas (ré)ingérer au démarrage et au chargement')
  .option('--db <path>', 'chemin de la base SQLite')
  .option('--projects-dir <path>', 'répertoire des transcripts Claude Code')
  .option('--pricing <path>', 'fichier de pricing override')
  .action(async (opts) => {
    const { runServe } = await import('./commands/serve.js');
    runServe({
      port: opts.port,
      host: opts.host,
      sessionsLimit: opts.limit,
      noIngest: opts.ingest === false,
      db: opts.db,
      projectsDir: opts.projectsDir,
      pricing: opts.pricing,
    });
  });

program
  .command('install')
  .description('Installe les intégrations Claude Code (statusline, skill /sessions, auto-démarrage)')
  .option('--statusline', 'installe uniquement la statusline')
  .option('--skill', 'installe uniquement la skill /sessions')
  .option('--autostart', 'installe le hook SessionStart (démarre le dashboard + ouvre le navigateur)')
  .action(async (opts) => {
    const { runInstall } = await import('./commands/install.js');
    runInstall({ statusline: opts.statusline, skill: opts.skill, autostart: opts.autostart });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  writeErr(`Erreur : ${(error as Error).message}`);
  process.exitCode = 1;
});
