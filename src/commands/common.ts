import pc from 'picocolors';
import { openDatabase, openReadOnly, type Db } from '../db/database.js';
import { ingest } from '../db/ingest.js';
import { databasePath, projectsDir as defaultProjectsDir } from '../config/paths.js';
import { writeErr } from '../format/output.js';

// Le résolveur de tarif vit dans pricing-loader (sans dépendance DB) ; on le ré-expose ici
// pour les commandes d'analyse, mais le statusline l'importe directement pour rester léger.
export { buildResolver } from '../pricing/pricing-loader.js';

/** Options communes à toutes les commandes d'analyse. */
export interface CommonOptions {
  db?: string;
  projectsDir?: string;
  pricing?: string;
  noIngest?: boolean;
  quiet?: boolean;
}

/** Résout le chemin effectif de la base. */
export function resolveDbPath(opts: CommonOptions): string {
  return opts.db ?? databasePath();
}

/** Résout le répertoire effectif des transcripts. */
export function resolveProjectsDir(opts: CommonOptions): string {
  return opts.projectsDir ?? defaultProjectsDir();
}

/** Crée un rappel de progression d'ingestion (écrit sur stderr, sauf en mode silencieux). */
export function makeProgress(
  quiet: boolean | undefined,
): ((done: number, total: number) => void) | undefined {
  if (quiet) {
    return undefined;
  }
  return (done, total) => {
    if (done === total || done % 250 === 0) {
      writeErr(`  ingestion… ${done}/${total}`);
    }
  };
}

/**
 * Ouvre la base pour lecture. Sauf `--no-ingest`, déclenche d'abord une ingestion incrémentale
 * (rapide après la première fois) et journalise un bilan sur stderr.
 * @returns la base, ou `null` si `--no-ingest` et qu'aucune base n'existe encore.
 */
export function openForRead(opts: CommonOptions): Db | null {
  if (opts.noIngest) {
    return openReadOnly(resolveDbPath(opts));
  }
  const db = openDatabase(resolveDbPath(opts));
  const result = ingest(db, resolveProjectsDir(opts), { onProgress: makeProgress(opts.quiet) });
  if (!opts.quiet) {
    if (result.agentsBackfilled) {
      writeErr(
        `Rattrapage du grain agent : ${result.agentsIngested} sous-agent(s) indexé(s) ` +
          `(passe complète, sans incidence sur les coûts déjà comptés).`,
      );
    }
    writeErr(
      `Ingestion : ${result.filesIngested} fichier(s) traité(s) / ${result.filesUnchanged} inchangé(s), ` +
        `${result.messagesCounted} message(s) comptés, ${result.messagesDuplicate} doublon(s) ignorés ` +
        `(${result.durationMs} ms).`,
    );
    if (result.linesCorrupted > 0) {
      writeErr(`  ${result.linesCorrupted} ligne(s) corrompue(s) ignorée(s).`);
    }
    const skipped = result.messagesSkippedNoId + result.messagesSkippedNoModel;
    if (skipped > 0) {
      writeErr(`  ${skipped} message(s) écarté(s) (sans id ou sans modèle).`);
    }
  }
  return db;
}

/** Signale sur stderr les modèles non tarifés ayant consommé des tokens. */
export function warnUnknownModels(models: string[]): void {
  if (models.length > 0) {
    writeErr(
      pc.yellow(
        `⚠ Modèles non tarifés (coût compté à 0) : ${models.join(', ')}. ` +
          `Ajoutez leurs tarifs via un fichier de pricing (CCMON_PRICING).`,
      ),
    );
  }
}
