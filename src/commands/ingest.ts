import { openDatabase } from '../db/database.js';
import { ingest } from '../db/ingest.js';
import { writeOut } from '../format/output.js';
import { makeProgress, resolveDbPath, resolveProjectsDir, type CommonOptions } from './common.js';

/** Options de la commande `ingest`. */
export interface IngestCommandOptions extends CommonOptions {
  /** Réindexe intégralement tous les fichiers. */
  force?: boolean;
}

/** Exécute l'ingestion des transcripts vers la base, avec bilan sur stdout. */
export function runIngest(opts: IngestCommandOptions): void {
  const db = openDatabase(resolveDbPath(opts));
  try {
    const result = ingest(db, resolveProjectsDir(opts), {
      force: opts.force,
      onProgress: makeProgress(opts.quiet),
    });

    if (opts.quiet) {
      return;
    }
    writeOut(`Fichiers scannés     : ${result.filesScanned}`);
    writeOut(`  traités            : ${result.filesIngested}`);
    writeOut(`  inchangés          : ${result.filesUnchanged}`);
    writeOut(`Lignes parsées       : ${result.linesParsed}`);
    writeOut(`  corrompues         : ${result.linesCorrupted}`);
    writeOut(`Messages comptés     : ${result.messagesCounted}`);
    writeOut(`  doublons ignorés   : ${result.messagesDuplicate}`);
    writeOut(`  sans id ignorés    : ${result.messagesSkippedNoId}`);
    writeOut(`Sous-agents indexés  : ${result.agentsIngested}`);
    if (result.agentsBackfilled) {
      writeOut('  (passe de rattrapage du grain agent : les coûts déjà comptés sont inchangés)');
    }
    writeOut(`Messages par skill   : ${result.skillMessagesIngested}`);
    writeOut(`Appels d’outils      : ${result.toolCallsIngested}`);
    writeOut(`  résultats encaissés: ${result.toolResultsIngested}`);
    if (result.skillsBackfilled) {
      writeOut('  (passe de rattrapage des grains skill et outil : les coûts déjà comptés sont inchangés)');
    }
    writeOut(`Durée                : ${result.durationMs} ms`);
  } finally {
    db.close();
  }
}
