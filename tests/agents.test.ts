import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/database.js';
import { ingest } from '../src/db/ingest.js';
import { getAgentsMeta, getAgentUsage, hasAgentTables } from '../src/db/queries.js';
import { aggregateAgents, groupAgentsBySession } from '../src/report/aggregate.js';
import { createResolver, loadPricingTable } from '../src/pricing/pricing-loader.js';
import {
  assistantEvent,
  makeTempDir,
  writeSessionFile,
  writeSubagentFile,
  writeSubagentMeta,
} from './helpers.js';

const resolver = createResolver(loadPricingTable());

/** Usage simple (input/output uniquement). */
function usage(input: number, output: number) {
  return { input_tokens: input, output_tokens: output };
}

/**
 * Fixture : une session avec deux agents (l'un `plan-code` sur Opus, l'autre `explore-code`
 * sur Haiku), plus un `journal.jsonl` de workflow qui n'est PAS un agent.
 */
function fixture(): { projectsDir: string } {
  const projectsDir = makeTempDir();
  writeSessionFile(projectsDir, '-proj', 'sess1', [
    { type: 'ai-title', aiTitle: 'Ma session', sessionId: 'sess1' },
    assistantEvent({
      id: 'main1',
      requestId: 'r0',
      model: 'claude-opus-4-8',
      timestamp: '2026-06-02T09:00:00Z',
      usage: usage(1_000_000, 0),
    }),
  ]);

  const planEvent = assistantEvent({
    id: 'a1m1',
    requestId: 'r1',
    model: 'claude-opus-4-8',
    timestamp: '2026-06-02T10:00:00Z',
    usage: usage(2_000_000, 0),
  });
  writeSubagentFile(projectsDir, '-proj', 'sess1', 'aaa', [
    planEvent,
    planEvent, // ligne dupliquée : un même message réparti sur plusieurs lignes
  ]);
  writeSubagentMeta(projectsDir, '-proj', 'sess1', 'aaa', {
    agentType: 'plan-code',
    description: 'RELECTURE-PLAN démo',
    spawnDepth: 1,
  });

  writeSubagentFile(projectsDir, '-proj', 'sess1', 'bbb', [
    assistantEvent({
      id: 'a2m1',
      requestId: 'r2',
      model: 'claude-haiku-4-5-20251001',
      timestamp: '2026-06-03T11:00:00Z',
      usage: usage(1_000_000, 0),
    }),
  ]);
  writeSubagentMeta(projectsDir, '-proj', 'sess1', 'bbb', {
    agentType: 'explore-code',
    description: 'Exploration démo',
    parentAgentId: 'aaa',
    spawnDepth: 2,
  });

  return { projectsDir };
}

/** Écrit un `journal.jsonl` de workflow : sous `subagents/`, mais ce n'est PAS un agent. */
function writeWorkflowJournal(projectsDir: string, projectSlug: string, sessionId: string): void {
  const dir = join(projectsDir, projectSlug, sessionId, 'subagents', 'workflows', 'wf_1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'x' })}\n`);
}

describe('ingestion du grain agent', () => {
  it('enregistre chaque agent avec son titre, son type et son modèle', () => {
    const { projectsDir } = fixture();
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);

    const metas = getAgentsMeta(db);
    expect(metas).toHaveLength(2);

    const plan = metas.find((m) => m.agentId === 'aaa');
    expect(plan).toMatchObject({
      sessionId: 'sess1',
      projectSlug: '-proj',
      agentType: 'plan-code',
      description: 'RELECTURE-PLAN démo',
      parentAgentId: null,
      spawnDepth: 1,
    });

    const explore = metas.find((m) => m.agentId === 'bbb');
    expect(explore).toMatchObject({ agentType: 'explore-code', parentAgentId: 'aaa', spawnDepth: 2 });

    const rows = getAgentUsage(db);
    expect(rows.map((r) => [r.agentId, r.model]).sort()).toEqual([
      ['aaa', 'claude-opus-4-8'],
      ['bbb', 'claude-haiku-4-5-20251001'],
    ]);
    db.close();
  });

  it('déduplique les lignes répétées d’un même message', () => {
    const { projectsDir } = fixture();
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);

    const plan = getAgentUsage(db).find((r) => r.agentId === 'aaa');
    // Deux lignes pour un seul message logique → un seul comptage.
    expect(plan?.messageCount).toBe(1);
    expect(plan?.counts.input).toBe(2_000_000);
    db.close();
  });

  it('n’ingère pas les fichiers de `subagents/` qui ne sont pas des agents', () => {
    const projectsDir = makeTempDir();
    writeSubagentFile(projectsDir, '-proj', 'sess1', 'real', [
      assistantEvent({ id: 'x', requestId: 'r', timestamp: '2026-06-02T10:00:00Z' }),
    ]);
    writeWorkflowJournal(projectsDir, '-proj', 'sess1');

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    expect(getAgentsMeta(db).map((m) => m.agentId)).toEqual(['real']);
    db.close();
  });

  it('n’altère pas le coût total de la session', () => {
    const { projectsDir } = fixture();
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);

    const total = db
      .prepare('SELECT SUM(input_tokens) AS input FROM usage_rollup WHERE session_id = ?')
      .get('sess1') as { input: number };
    // 1 M (principal) + 2 M (agent aaa) + 1 M (agent bbb), la ligne dupliquée exclue.
    expect(total.input).toBe(4_000_000);
    db.close();
  });

  it('reste idempotente : deux ingestions donnent le même grain agent', () => {
    const { projectsDir } = fixture();
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const first = getAgentUsage(db);
    ingest(db, projectsDir, { force: true });
    expect(getAgentUsage(db)).toEqual(first);
    db.close();
  });
});

describe('rattrapage du grain agent', () => {
  /** Simule une base ingérée AVANT l'ajout du grain agent : curseurs pleins, tables agents vides. */
  function simulateLegacyDatabase(db: Db): void {
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM agent_rollup');
    db.exec("DELETE FROM meta WHERE key = 'agents_backfilled'");
  }

  it('reconstruit le grain agent sur des transcripts déjà ingérés', () => {
    const { projectsDir } = fixture();
    const db = openDatabase(':memory:');

    const initial = ingest(db, projectsDir);
    expect(initial.agentsBackfilled).toBe(true);
    expect(initial.agentsIngested).toBe(2);

    // Sans rattrapage, le curseur incrémental sauterait ces fichiers et le grain resterait vide.
    simulateLegacyDatabase(db);
    const unchanged = ingest(db, projectsDir);
    expect(unchanged.filesUnchanged).toBe(0); // la passe est forcée
    expect(getAgentsMeta(db)).toHaveLength(2);

    // Une fois le drapeau posé, l'ingestion redevient incrémentale.
    const after = ingest(db, projectsDir);
    expect(after.agentsBackfilled).toBe(false);
    expect(after.filesUnchanged).toBeGreaterThan(0);
    expect(after.agentsIngested).toBe(0);
    db.close();
  });

  it('ne recompte aucun message pendant le rattrapage', () => {
    const { projectsDir } = fixture();
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const before = db.prepare('SELECT SUM(input_tokens) AS input FROM usage_rollup').get() as {
      input: number;
    };

    simulateLegacyDatabase(db);
    const backfill = ingest(db, projectsDir);
    expect(backfill.messagesCounted).toBe(0);

    const after = db.prepare('SELECT SUM(input_tokens) AS input FROM usage_rollup').get() as {
      input: number;
    };
    expect(after.input).toBe(before.input);
    db.close();
  });
});

describe('agrégation des agents', () => {
  it('coûte chaque agent et le rattache à sa session', () => {
    const { projectsDir } = fixture();
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);

    const report = aggregateAgents(getAgentUsage(db), getAgentsMeta(db), resolver);
    expect(report.rows).toHaveLength(2);

    const plan = report.rows.find((r) => r.meta.agentId === 'aaa');
    expect(plan?.models).toEqual(['claude-opus-4-8']);
    expect(plan?.cost).toBeGreaterThan(0);
    expect(plan?.title).toBe('RELECTURE-PLAN démo');

    const bySession = groupAgentsBySession(report);
    expect(bySession.get('sess1')).toHaveLength(2);
    db.close();
  });

  it('filtre les agents par période', () => {
    const { projectsDir } = fixture();
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);

    const rows = getAgentUsage(db, { since: '2026-06-03', until: '2026-06-03' });
    expect(rows.map((r) => r.agentId)).toEqual(['bbb']);
    db.close();
  });

  it('conserve un agent sans consommation, avec un coût nul', () => {
    const projectsDir = makeTempDir();
    writeSubagentFile(projectsDir, '-proj', 'sess1', 'vide', []);
    writeSubagentMeta(projectsDir, '-proj', 'sess1', 'vide', {
      agentType: 'Explore',
      description: 'Agent sans réponse',
    });

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const report = aggregateAgents(getAgentUsage(db), getAgentsMeta(db), resolver);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].cost).toBe(0);
    expect(report.rows[0].models).toEqual([]);
    db.close();
  });

  it('retombe sur le type puis l’identifiant quand la description manque', () => {
    const projectsDir = makeTempDir();
    writeSubagentFile(projectsDir, '-proj', 'sess1', 'wf', [
      assistantEvent({ id: 'w1', requestId: 'r1', timestamp: '2026-06-02T10:00:00Z' }),
    ]);
    writeSubagentMeta(projectsDir, '-proj', 'sess1', 'wf', { agentType: 'workflow-subagent' });

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const report = aggregateAgents(getAgentUsage(db), getAgentsMeta(db), resolver);
    expect(report.rows[0].title).toBe('workflow-subagent');
    db.close();
  });
});

describe('hasAgentTables', () => {
  it('reconnaît une base pourvue du grain agent', () => {
    const db = openDatabase(':memory:');
    expect(hasAgentTables(db)).toBe(true);
    db.exec('DROP TABLE agent_rollup');
    expect(hasAgentTables(db)).toBe(false);
    db.close();
  });

  it('renvoie des résultats vides sur une base dépourvue des tables', () => {
    const db = openDatabase(':memory:');
    db.exec('DROP TABLE agent_rollup');
    db.exec('DROP TABLE agents');
    expect(getAgentUsage(db)).toEqual([]);
    expect(getAgentsMeta(db)).toEqual([]);
    db.close();
  });
});
