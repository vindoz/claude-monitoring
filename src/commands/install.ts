import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsPath, skillsDir } from '../config/paths.js';
import { writeErr, writeOut } from '../format/output.js';

/** Options de la commande `install`. */
export interface InstallOptions {
  /** Installe la statusline dans `settings.json`. */
  statusline?: boolean;
  /** Installe la skill `/sessions`. */
  skill?: boolean;
}

/** Racine du paquet (à partir de `dist/commands/install.js` ou `src/commands/install.ts`). */
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..');
}

/**
 * Ajoute la clé `statusLine` à `settings.json` sans écraser le reste.
 * Sauvegarde l'ancien fichier en `.bak` et valide le JSON produit.
 */
function installStatusline(): void {
  const path = settingsPath();
  const scriptPath = join(packageRoot(), 'scripts', 'statusline.sh');

  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    settings = JSON.parse(raw) as Record<string, unknown>;
    writeFileSync(`${path}.bak`, raw);
  }

  settings.statusLine = { type: 'command', command: scriptPath, padding: 2 };
  const serialized = JSON.stringify(settings, null, 2);
  JSON.parse(serialized); // garde-fou : on ne réécrit que du JSON valide
  writeFileSync(path, `${serialized}\n`);
  writeOut(`statusLine configurée dans ${path} (sauvegarde : ${path}.bak).`);
}

/**
 * Installe la skill `/sessions` en injectant le chemin réel du binaire (placeholder
 * `__CCMON_BIN__`), de façon à fonctionner même si `ccmon` n'est pas dans le PATH.
 */
function installSkill(): void {
  const src = join(packageRoot(), 'integration', 'sessions-skill', 'SKILL.md');
  const destDir = join(skillsDir(), 'sessions');
  const binCommand = `node ${join(packageRoot(), 'dist', 'cli.js')}`;

  const template = readFileSync(src, 'utf8');
  const content = template.replaceAll('__CCMON_BIN__', binCommand);

  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, 'SKILL.md'), content);
  writeOut(`Skill /sessions installée dans ${destDir}.`);
}

/** Exécute l'installation des intégrations Claude Code (statusline et/ou skill). */
export function runInstall(opts: InstallOptions): void {
  // Sans option explicite, on installe les deux intégrations.
  const doAll = !opts.statusline && !opts.skill;

  if (opts.statusline || doAll) {
    try {
      installStatusline();
    } catch (error) {
      writeErr(`Échec de l'installation de la statusline : ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
  if (opts.skill || doAll) {
    try {
      installSkill();
    } catch (error) {
      writeErr(`Échec de l'installation de la skill : ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}
