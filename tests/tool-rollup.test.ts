import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/database.js';
import { ingest } from '../src/db/ingest.js';
import { getToolUsage } from '../src/db/queries.js';
import { aggregateTools, estimateTokensFromChars } from '../src/report/aggregate.js';
import { serverOfTool, NO_SKILL } from '../src/report/usage-aggregation.js';
import {
  assistantEvent,
  makeTempDir,
  toJsonl,
  toolResultEvent,
  toolUseLine,
  writeSessionFile,
  writeSubagentFile,
} from './helpers.js';

/** Totaux bruts de `tool_rollup`, pour vérifier l'absence de double comptage. */
function toolTotals(db: Db): { calls: number; chars: number; errors: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(call_count), 0) AS calls,
              COALESCE(SUM(result_chars), 0) AS chars,
              COALESCE(SUM(error_count), 0) AS errors
       FROM tool_rollup`,
    )
    .get() as { calls: number; chars: number; errors: number };
  return row;
}

describe('grain outil — ingestion', () => {
  it('relève un `tool_use` porté par une ligne que la dédup du grain session rejette', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      // Les deux lignes partagent id + requestId et répètent `usage`, comme un transcript réel.
      assistantEvent({ id: 'm1', requestId: 'r1', timestamp: '2026-06-02T10:00:00Z', attributionSkill: 'jira' }),
      toolUseLine({
        id: 'm1',
        requestId: 'r1',
        timestamp: '2026-06-02T10:00:00Z',
        attributionSkill: 'jira',
        toolUseId: 'toolu_1',
        toolName: 'mcp__jira__jira_get_issue',
      }),
      toolResultEvent({ toolUseId: 'toolu_1', content: 'x'.repeat(400), timestamp: '2026-06-02T10:00:01Z' }),
    ]);

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);

    const rows = getToolUsage(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'mcp__jira__jira_get_issue',
      server: 'mcp:jira',
      skill: 'jira',
      callCount: 1,
      errorCount: 0,
      resultChars: 400,
      resultImages: 0,
    });
    // Le message facturé, lui, n'est compté qu'une fois malgré ses deux lignes.
    const usage = db.prepare('SELECT SUM(message_count) AS n FROM usage_rollup').get() as { n: number };
    expect(usage.n).toBe(1);
  });

  it('ne double AUCUN compteur sur ré-ingestion, y compris forcée', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      toolUseLine({
        id: 'm1',
        requestId: 'r1',
        timestamp: '2026-06-02T10:00:00Z',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
      }),
      toolResultEvent({ toolUseId: 'toolu_1', content: 'sortie', isError: true, timestamp: '2026-06-02T10:00:01Z' }),
    ]);

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const after1 = toolTotals(db);
    expect(after1).toEqual({ calls: 1, chars: 6, errors: 1 });

    ingest(db, projectsDir);
    ingest(db, projectsDir, { force: true });
    ingest(db, projectsDir, { force: true });
    expect(toolTotals(db)).toEqual(after1);
  });

  it('ne double pas les compteurs d’un transcript d’AGENT, toujours relu depuis la ligne 0', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', timestamp: '2026-06-02T10:00:00Z' }),
    ]);
    writeSubagentFile(projectsDir, '-proj', 'sess1', 'a1', [
      toolUseLine({
        id: 's1',
        requestId: 'rs',
        timestamp: '2026-06-02T10:02:00Z',
        toolUseId: 'toolu_agent',
        toolName: 'Read',
      }),
      toolResultEvent({ toolUseId: 'toolu_agent', content: 'abcd', timestamp: '2026-06-02T10:02:01Z' }),
    ]);

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const after1 = toolTotals(db);
    // Le transcript d'agent est relu intégralement à chaque passage : c'est précisément le
    // scénario où un marqueur d'unicité supprimé après usage referait monter le compteur.
    ingest(db, projectsDir);
    ingest(db, projectsDir);
    expect(toolTotals(db)).toEqual(after1);
    expect(after1.calls).toBe(1);
  });

  it('encaisse un résultat arrivé dans une fenêtre d’ingestion ULTÉRIEURE', () => {
    const projectsDir = makeTempDir();
    const path = writeSessionFile(projectsDir, '-proj', 'sess1', [
      toolUseLine({
        id: 'm1',
        requestId: 'r1',
        timestamp: '2026-06-02T10:00:00Z',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
      }),
    ]);

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    expect(toolTotals(db)).toEqual({ calls: 1, chars: 0, errors: 0 });

    // La session continue d'écrire : le résultat n'arrive qu'après la première ingestion.
    appendFileSync(
      path,
      toJsonl([toolResultEvent({ toolUseId: 'toolu_1', content: '0123456789', timestamp: '2026-06-02T10:00:01Z' })]),
    );
    ingest(db, projectsDir);
    expect(toolTotals(db)).toEqual({ calls: 1, chars: 10, errors: 0 });

    // Et il ne s'encaisse pas une seconde fois.
    ingest(db, projectsDir, { force: true });
    expect(toolTotals(db)).toEqual({ calls: 1, chars: 10, errors: 0 });
  });

  it('compte les images à part et ignore leur charge utile dans le poids de texte', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      toolUseLine({
        id: 'm1',
        requestId: 'r1',
        timestamp: '2026-06-02T10:00:00Z',
        toolUseId: 'toolu_1',
        toolName: 'mcp__chrome-devtools__take_screenshot',
      }),
      toolResultEvent({
        toolUseId: 'toolu_1',
        timestamp: '2026-06-02T10:00:01Z',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'image', source: { type: 'base64', data: 'A'.repeat(50_000) } },
        ],
      }),
    ]);

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const rows = getToolUsage(db);
    expect(rows[0].server).toBe('mcp:chrome-devtools');
    expect(rows[0].resultChars).toBe(2); // le base64 n'entre PAS dans le poids de texte
    expect(rows[0].resultImages).toBe(1);
  });

  it('impute les appels au skill actif au moment de l’appel', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      toolUseLine({ id: 'm1', requestId: 'r1', timestamp: '2026-06-02T10:00:00Z', toolUseId: 't1', toolName: 'Bash', attributionSkill: 'epct' }),
      toolUseLine({ id: 'm2', requestId: 'r2', timestamp: '2026-06-02T10:01:00Z', toolUseId: 't2', toolName: 'Bash' }),
    ]);
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const skills = getToolUsage(db)
      .map((r) => r.skill)
      .sort();
    expect(skills).toEqual([NO_SKILL, 'epct']);
  });
});

describe('serverOfTool', () => {
  it('reconnaît un outil MCP et son serveur', () => {
    expect(serverOfTool('mcp__jira__jira_get_issue')).toBe('mcp:jira');
    expect(serverOfTool('mcp__chrome-devtools__click')).toBe('mcp:chrome-devtools');
  });

  it('classe les outils natifs en `builtin`', () => {
    expect(serverOfTool('Bash')).toBe('builtin');
    expect(serverOfTool('AskUserQuestion')).toBe('builtin');
  });
});

describe('aggregateTools', () => {
  it('replie les outils par serveur sans jamais calculer de coût', () => {
    const report = aggregateTools([
      { tool: 'mcp__jira__a', server: 'mcp:jira', skill: 'jira', projectSlug: '-p', callCount: 2, errorCount: 0, resultChars: 800, resultImages: 0 },
      { tool: 'mcp__jira__b', server: 'mcp:jira', skill: 'jira', projectSlug: '-p', callCount: 1, errorCount: 1, resultChars: 200, resultImages: 0 },
      { tool: 'Bash', server: 'builtin', skill: 'epct', projectSlug: '-p', callCount: 5, errorCount: 0, resultChars: 100, resultImages: 2 },
    ]);
    expect(report.total).toEqual({ callCount: 8, errorCount: 1, resultChars: 1100, resultImages: 2 });
    expect(report.servers.map((s) => s.server)).toEqual(['mcp:jira', 'builtin']);
    expect(report.servers[0]).toMatchObject({ callCount: 3, resultChars: 1000, errorCount: 1 });
    expect(report).not.toHaveProperty('cost');
  });
});

describe('estimateTokensFromChars', () => {
  it('donne un ordre de grandeur à 4 caractères par token', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(400)).toBe(100);
    expect(estimateTokensFromChars(3)).toBe(1);
  });
});
