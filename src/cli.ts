#!/usr/bin/env node
import { Command } from 'commander';
import { runIngest } from './commands/ingest.js';
import { runSessions } from './commands/sessions.js';
import { runSummary } from './commands/summary.js';
import { runStatusline } from './commands/statusline.js';
import { runServe } from './commands/serve.js';
import { runInstall } from './commands/install.js';
import { writeErr } from './format/output.js';
import type { Dimension } from './db/queries.js';

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
  .action((opts) => {
    runIngest({
      force: opts.force,
      db: opts.db,
      projectsDir: opts.projectsDir,
      quiet: opts.quiet,
    });
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
  .action((opts) => {
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
  .action((opts) => {
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
    await runStatusline({
      format: opts.format,
      noColor: opts.color === false,
    });
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
  .action((opts) => {
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
  .action((opts) => {
    runInstall({ statusline: opts.statusline, skill: opts.skill, autostart: opts.autostart });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  writeErr(`Erreur : ${(error as Error).message}`);
  process.exitCode = 1;
});
