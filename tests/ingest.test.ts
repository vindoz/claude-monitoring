import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/database.js';
import { ingest } from '../src/db/ingest.js';
import { getSessionsMeta, getUsageByDimension, isDatabaseEmpty } from '../src/db/queries.js';
import {
  assistantEvent,
  makeTempDir,
  toJsonl,
  writeSessionFile,
  writeSubagentFile,
} from './helpers.js';

/** Usage simple (input/output uniquement). */
function usage(input: number, output: number) {
  return { input_tokens: input, output_tokens: output };
}

describe('ingest', () => {
  it('ingère récursivement sessions et sous-agents, déduplique et exclut les synthétiques', () => {
    const projectsDir = makeTempDir();
    const m1 = assistantEvent({
      id: 'm1',
      requestId: 'r1',
      model: 'claude-opus-4-8',
      timestamp: '2026-06-02T10:00:00Z',
      usage: usage(1_000_000, 0),
    });
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      { type: 'ai-title', aiTitle: 'Ma session', sessionId: 'sess1' },
      m1,
      m1, // ligne dupliquée (même id/requestId) → ignorée
      assistantEvent({
        id: 'm2',
        requestId: 'r2',
        model: 'claude-haiku-4-5-20251001',
        timestamp: '2026-06-01T08:00:00Z', // antérieur → teste first_ts = MIN
        usage: usage(2_000_000, 0),
      }),
      { type: 'assistant', requestId: 'r3', message: { id: 'm3', model: '<synthetic>', usage: usage(999, 0) } },
    ]);
    writeSubagentFile(projectsDir, '-proj', 'sess1', 'a1', [
      assistantEvent({ id: 's1', requestId: 'rs', model: 'claude-opus-4-8', timestamp: '2026-06-03T09:00:00Z', usage: usage(500_000, 0) }),
    ]);

    const db = openDatabase(':memory:');
    const result = ingest(db, projectsDir);

    expect(result.messagesCounted).toBe(3); // m1, m2, s1 (m3 synthétique exclu)
    expect(result.messagesDuplicate).toBe(1);

    // Agrégation par session : un seul sessionId, le sous-agent y est rattaché.
    const bySession = getUsageByDimension(db, 'session');
    const sessionKeys = new Set(bySession.map((r) => r.key));
    expect([...sessionKeys]).toEqual(['sess1']);

    // Métadonnées : titre + bornes temporelles MIN/MAX malgré l'ordre des events.
    const metas = getSessionsMeta(db);
    expect(metas[0].title).toBe('Ma session');
    expect(metas[0].firstTs).toBe(Date.parse('2026-06-01T08:00:00Z'));
    expect(metas[0].lastTs).toBe(Date.parse('2026-06-03T09:00:00Z'));

    db.close();
  });

  it('est incrémental : inchangé puis reprise en append', () => {
    const projectsDir = makeTempDir();
    const path = writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', usage: usage(1000, 0), timestamp: '2026-06-01T10:00:00Z' }),
    ]);
    const db = openDatabase(':memory:');

    const first = ingest(db, projectsDir);
    expect(first.messagesCounted).toBe(1);

    const unchanged = ingest(db, projectsDir);
    expect(unchanged.filesUnchanged).toBe(1);
    expect(unchanged.messagesCounted).toBe(0);

    // Ajout d'une ligne → fichier agrandi → reprise après lines_read.
    appendFileSync(path, toJsonl([assistantEvent({ id: 'm2', requestId: 'r2', usage: usage(2000, 0), timestamp: '2026-06-01T11:00:00Z' })]));
    const grown = ingest(db, projectsDir);
    expect(grown.messagesCounted).toBe(1);

    db.close();
  });

  it('est idempotent en ré-ingestion forcée (pas de double comptage)', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', usage: usage(1_000_000, 0), timestamp: '2026-06-01T10:00:00Z' }),
    ]);
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const before = totalInput(db);
    ingest(db, projectsDir, { force: true });
    expect(totalInput(db)).toBe(before);
    db.close();
  });

  it('ignore les messages assistant sans identifiant', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      { type: 'assistant', requestId: 'r1', timestamp: '2026-06-01T10:00:00Z', message: { model: 'claude-opus-4-8', usage: usage(1000, 0) } },
    ]);
    const db = openDatabase(':memory:');
    const result = ingest(db, projectsDir);
    expect(result.messagesSkippedNoId).toBe(1);
    expect(result.messagesCounted).toBe(0);
    db.close();
  });
});

describe('queries', () => {
  it('agrège par modèle et par jour, et détecte une base vide', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', timestamp: '2026-06-01T10:00:00Z', usage: usage(1000, 0) }),
      assistantEvent({ id: 'm2', requestId: 'r2', model: 'claude-haiku-4-5', timestamp: '2026-06-02T10:00:00Z', usage: usage(2000, 0) }),
    ]);
    const db = openDatabase(':memory:');
    expect(isDatabaseEmpty(db)).toBe(true);
    ingest(db, projectsDir);
    expect(isDatabaseEmpty(db)).toBe(false);

    const byModel = getUsageByDimension(db, 'model');
    expect(byModel.map((r) => r.key).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);

    const byDay = getUsageByDimension(db, 'day');
    expect(byDay.map((r) => r.key).sort()).toEqual(['2026-06-01', '2026-06-02']);

    // Filtre par projet
    const filtered = getUsageByDimension(db, 'model', { project: '-proj' });
    expect(filtered.length).toBe(2);
    const none = getUsageByDimension(db, 'model', { project: '-inexistant' });
    expect(none.length).toBe(0);

    db.close();
  });
});

/** Somme des tokens d'entrée stockés (pour vérifier l'idempotence). */
function totalInput(db: Db): number {
  const row = db.prepare('SELECT COALESCE(SUM(input_tokens), 0) AS n FROM usage_rollup').get() as { n: number };
  return row.n;
}
