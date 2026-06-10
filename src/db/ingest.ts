import { type Dirent, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './database.js';
import { readJsonlFromLine } from '../parser/jsonl-parser.js';
import { parseSessionPath } from '../parser/session-path.js';
import { isAiTitleEvent, isAssistantEvent } from '../types/claude-events.js';
import { isSyntheticModel } from '../pricing/model-normalizer.js';
import { usageFromClaude } from '../pricing/cost-model.js';

/** Bilan d'une ingestion. */
export interface IngestResult {
  filesScanned: number;
  filesIngested: number;
  filesUnchanged: number;
  linesParsed: number;
  linesCorrupted: number;
  messagesCounted: number;
  messagesDuplicate: number;
  messagesSkippedNoId: number;
  messagesSkippedNoModel: number;
  durationMs: number;
}

/** Options d'ingestion. */
export interface IngestOptions {
  /** Réindexe intégralement tous les fichiers (ignore le curseur incrémental). */
  force?: boolean;
  /** Rappel de progression (appelé pour chaque fichier traité), pour l'affichage. */
  onProgress?: (done: number, total: number) => void;
}

/** Liste récursivement tous les fichiers `.jsonl` sous un répertoire. */
export function walkJsonlFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return; // répertoire illisible : on l'ignore silencieusement
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

/** Convertit un horodatage ISO en millisecondes, ou `null` si absent/invalide. */
function tsToMs(timestamp: string | undefined): number | null {
  if (!timestamp) {
    return null;
  }
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/** Extrait le jour `YYYY-MM-DD` (UTC) d'un horodatage ISO, ou `'unknown'`. */
function tsToDay(timestamp: string | undefined): string {
  if (timestamp && timestamp.length >= 10) {
    return timestamp.slice(0, 10);
  }
  return 'unknown';
}

/** Accumulateur de métadonnées de session sur un fichier. */
interface SessionAccumulator {
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * Lance l'ingestion incrémentale récursive des transcripts vers la base.
 * Idempotente : la déduplication `(message_id, request_id)` garantit qu'une ré-ingestion
 * (totale ou partielle) ne double jamais les coûts.
 */
export function ingest(db: Db, projectsDir: string, options: IngestOptions = {}): IngestResult {
  const startedAt = Date.now();
  const result: IngestResult = {
    filesScanned: 0,
    filesIngested: 0,
    filesUnchanged: 0,
    linesParsed: 0,
    linesCorrupted: 0,
    messagesCounted: 0,
    messagesDuplicate: 0,
    messagesSkippedNoId: 0,
    messagesSkippedNoModel: 0,
    durationMs: 0,
  };

  const selFile = db.prepare<[string]>(
    'SELECT size, mtime_ms AS mtimeMs, lines_read AS linesRead FROM ingested_files WHERE path = ?',
  );
  const upsertFile = db.prepare(
    `INSERT INTO ingested_files (path, size, mtime_ms, lines_read, ingested_at)
     VALUES (@path, @size, @mtimeMs, @linesRead, @ingestedAt)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size, mtime_ms = excluded.mtime_ms,
       lines_read = excluded.lines_read, ingested_at = excluded.ingested_at`,
  );
  const insSeen = db.prepare<[string, string]>(
    'INSERT OR IGNORE INTO seen_messages (message_id, request_id) VALUES (?, ?)',
  );
  const upsertRollup = db.prepare(
    `INSERT INTO usage_rollup (
       session_id, project_slug, model, day, message_count,
       input_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens,
       output_tokens, web_search_requests, web_fetch_requests)
     VALUES (
       @sessionId, @projectSlug, @model, @day, 1,
       @input, @cw5, @cw1, @cacheRead, @output, @webSearch, @webFetch)
     ON CONFLICT(session_id, model, day) DO UPDATE SET
       message_count         = message_count + 1,
       input_tokens          = input_tokens + excluded.input_tokens,
       cache_write_5m_tokens = cache_write_5m_tokens + excluded.cache_write_5m_tokens,
       cache_write_1h_tokens = cache_write_1h_tokens + excluded.cache_write_1h_tokens,
       cache_read_tokens     = cache_read_tokens + excluded.cache_read_tokens,
       output_tokens         = output_tokens + excluded.output_tokens,
       web_search_requests   = web_search_requests + excluded.web_search_requests,
       web_fetch_requests    = web_fetch_requests + excluded.web_fetch_requests`,
  );
  const upsertSession = db.prepare(
    `INSERT INTO sessions (session_id, project_slug, cwd, title, first_ts, last_ts, git_branch)
     VALUES (@sessionId, @projectSlug, @cwd, @title, @firstTs, @lastTs, @gitBranch)
     ON CONFLICT(session_id) DO UPDATE SET
       project_slug = excluded.project_slug,
       cwd        = COALESCE(excluded.cwd, cwd),
       git_branch = COALESCE(excluded.git_branch, git_branch),
       title      = COALESCE(excluded.title, title),
       first_ts   = MIN(COALESCE(first_ts, excluded.first_ts), COALESCE(excluded.first_ts, first_ts)),
       last_ts    = MAX(COALESCE(last_ts, excluded.last_ts), COALESCE(excluded.last_ts, last_ts))`,
  );

  const files = walkJsonlFiles(projectsDir);
  result.filesScanned = files.length;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const info = parseSessionPath(file, projectsDir);
    if (!info) {
      continue;
    }

    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(file);
      size = st.size;
      mtimeMs = Math.floor(st.mtimeMs);
    } catch {
      continue; // fichier disparu entre le walk et le stat
    }

    const prev = options.force
      ? undefined
      : (selFile.get(file) as { size: number; mtimeMs: number; linesRead: number } | undefined);

    let startLine = 0;
    if (prev) {
      if (prev.size === size && prev.mtimeMs === mtimeMs) {
        result.filesUnchanged += 1;
        options.onProgress?.(i + 1, files.length);
        continue; // inchangé
      }
      // Fichier agrandi → reprise en append ; sinon (rétréci / réécrit) → ré-ingestion totale.
      startLine = size > prev.size ? prev.linesRead : 0;
    }

    const read = readJsonlFromLine(file, startLine);
    result.linesParsed += read.parsedCount;
    result.linesCorrupted += read.corruptedCount;

    const acc: SessionAccumulator = {
      cwd: null,
      gitBranch: null,
      title: null,
      firstTs: null,
      lastTs: null,
    };

    const runFile = db.transaction(() => {
      for (const { event } of read.events) {
        if (isAiTitleEvent(event)) {
          if (event.aiTitle) {
            acc.title = event.aiTitle;
          }
          continue;
        }
        if (!isAssistantEvent(event)) {
          continue;
        }

        const ms = tsToMs(event.timestamp);
        if (ms !== null) {
          acc.firstTs = acc.firstTs === null ? ms : Math.min(acc.firstTs, ms);
          acc.lastTs = acc.lastTs === null ? ms : Math.max(acc.lastTs, ms);
        }
        if (event.cwd) {
          acc.cwd = event.cwd;
        }
        if (event.gitBranch) {
          acc.gitBranch = event.gitBranch;
        }

        const model = event.message?.model;
        if (!model || isSyntheticModel(model)) {
          if (!model) {
            result.messagesSkippedNoModel += 1;
          }
          continue;
        }
        const messageId = event.message?.id;
        if (!messageId) {
          result.messagesSkippedNoId += 1;
          continue;
        }
        const requestId = event.requestId ?? '';
        const inserted = insSeen.run(messageId, requestId);
        if (inserted.changes === 0) {
          result.messagesDuplicate += 1;
          continue; // message déjà compté (ligne répétée ou session rejouée)
        }

        const counts = usageFromClaude(event.message?.usage);
        upsertRollup.run({
          sessionId: info.sessionId,
          projectSlug: info.projectSlug,
          model,
          day: tsToDay(event.timestamp),
          input: counts.input,
          cw5: counts.cacheWrite5m,
          cw1: counts.cacheWrite1h,
          cacheRead: counts.cacheRead,
          output: counts.output,
          webSearch: counts.webSearch,
          webFetch: counts.webFetch,
        });
        result.messagesCounted += 1;
      }

      upsertSession.run({
        sessionId: info.sessionId,
        projectSlug: info.projectSlug,
        cwd: acc.cwd,
        title: acc.title,
        firstTs: acc.firstTs,
        lastTs: acc.lastTs,
        gitBranch: acc.gitBranch,
      });
      upsertFile.run({
        path: file,
        size,
        mtimeMs,
        linesRead: read.totalLines,
        ingestedAt: Date.now(),
      });
    });
    runFile();
    result.filesIngested += 1;
    options.onProgress?.(i + 1, files.length);
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
