import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

/** Type de l'instance better-sqlite3 (alias pour la lisibilité des signatures). */
export type Db = Database.Database;

/**
 * Ouvre (et crée si besoin) la base en lecture/écriture, applique les PRAGMA de performance
 * et garantit l'existence du schéma.
 */
export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Ouvre la base en lecture seule (commandes d'analyse sans ingestion).
 * Tolère l'absence de fichier en renvoyant `null` : l'appelant affichera une base vide.
 */
export function openReadOnly(path: string): Db | null {
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    return db;
  } catch {
    return null;
  }
}
