import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeEvent } from '../types/claude-events.js';

/** Liste récursivement tous les fichiers `.jsonl` sous un répertoire (répertoires illisibles ignorés). */
export function walkJsonlFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

/**
 * Résultat de la lecture d'un transcript JSONL.
 */
export interface JsonlReadResult {
  /** Events parsés avec succès, dans l'ordre du fichier, avec leur index de ligne (0-based). */
  events: Array<{ event: ClaudeEvent; lineIndex: number }>;
  /** Nombre total de lignes COMPLÈTES du fichier (sert de curseur d'ingestion incrémentale). */
  totalLines: number;
  /** Nombre de lignes parsées avec succès dans la fenêtre lue. */
  parsedCount: number;
  /** Nombre de lignes corrompues (JSON invalide) ignorées dans la fenêtre lue. */
  corruptedCount: number;
}

/**
 * Découpe un contenu JSONL en lignes complètes.
 * Une dernière ligne non terminée par un saut de ligne est considérée comme un écriture
 * partielle (session active) et écartée : elle sera reprise à la prochaine ingestion.
 *
 * @returns la liste des lignes complètes (chaînes brutes, vides incluses).
 */
export function splitCompleteLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const parts = content.split('\n');
  // `split` produit toujours un dernier élément après le dernier '\n'.
  // S'il y a un '\n' final, ce dernier élément est '' → on le retire.
  // Sinon, c'est une ligne incomplète (écriture en cours) → on la retire également.
  parts.pop();
  return parts;
}

/**
 * Lit un fichier transcript JSONL à partir d'une ligne donnée et parse chaque ligne en event.
 * La lecture est tolérante : une ligne au JSON invalide est comptée puis ignorée, jamais fatale.
 *
 * @param filePath chemin absolu du fichier `.jsonl`.
 * @param startLine index de la première ligne à traiter (0-based) ; les lignes précédentes,
 *                  déjà ingérées, sont sautées. Mettre 0 pour une (ré)ingestion complète.
 */
export function readJsonlFromLine(filePath: string, startLine = 0): JsonlReadResult {
  const content = readFileSync(filePath, 'utf8');
  const lines = splitCompleteLines(content);
  const totalLines = lines.length;

  const events: Array<{ event: ClaudeEvent; lineIndex: number }> = [];
  let parsedCount = 0;
  let corruptedCount = 0;

  for (let lineIndex = Math.max(0, startLine); lineIndex < totalLines; lineIndex += 1) {
    const raw = lines[lineIndex];
    if (raw.trim().length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(raw) as ClaudeEvent;
      events.push({ event, lineIndex });
      parsedCount += 1;
    } catch {
      // Ligne corrompue (JSON tronqué/invalide) : on la compte et on poursuit.
      corruptedCount += 1;
    }
  }

  return { events, totalLines, parsedCount, corruptedCount };
}
