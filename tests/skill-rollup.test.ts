import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/database.js';
import { ingest } from '../src/db/ingest.js';
import { getSkillEdges, getSkillUsage, getUsageByDimension } from '../src/db/queries.js';
import { aggregateSkills, resolveRootSkill, indexSkillEdges } from '../src/report/aggregate.js';
import { buildResolver } from '../src/pricing/pricing-loader.js';
import { NO_SKILL } from '../src/report/usage-aggregation.js';
import { assistantEvent, makeTempDir, toolUseLine, writeSessionFile, writeSubagentFile } from './helpers.js';

/** Usage simple (input/output uniquement). */
function usage(input: number, output: number) {
  return { input_tokens: input, output_tokens: output };
}

/** Somme des messages d'une table de rollup. */
function sumMessages(db: Db, table: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(message_count), 0) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('grain skill — ingestion', () => {
  it('impute les messages au skill actif et laisse les autres sous une clé explicite', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', timestamp: '2026-06-02T10:00:00Z', usage: usage(1000, 10) }),
      assistantEvent({
        id: 'm2',
        requestId: 'r2',
        timestamp: '2026-06-02T10:01:00Z',
        usage: usage(2000, 20),
        attributionSkill: 'epct',
      }),
    ]);

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);

    const rows = getSkillUsage(db);
    const bySkill = new Map(rows.map((r) => [r.skill, r]));
    expect([...bySkill.keys()].sort()).toEqual([NO_SKILL, 'epct']);
    expect(bySkill.get('epct')?.counts.input).toBe(2000);
    expect(bySkill.get(NO_SKILL)?.counts.input).toBe(1000);
  });

  it('totalise exactement le grain session (aucun message perdu, aucun compté deux fois)', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', timestamp: '2026-06-02T10:00:00Z', attributionSkill: 'epct' }),
      assistantEvent({ id: 'm2', requestId: 'r2', timestamp: '2026-06-02T10:01:00Z' }),
    ]);
    writeSubagentFile(projectsDir, '-proj', 'sess1', 'a1', [
      assistantEvent({ id: 's1', requestId: 'rs', timestamp: '2026-06-02T10:02:00Z', attributionSkill: 'epct' }),
    ]);

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    expect(sumMessages(db, 'skill_rollup')).toBe(sumMessages(db, 'usage_rollup'));
  });

  it('RATTRAPE le grain sur une base dont `seen_messages` est déjà plein', () => {
    // Reproduit la montée de version sur une base existante : sans déduplication PROPRE au
    // grain skill, la barrière `seen_messages` ferait de la passe forcée un no-op silencieux.
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', timestamp: '2026-06-02T10:00:00Z', attributionSkill: 'epct' }),
      assistantEvent({ id: 'm2', requestId: 'r2', timestamp: '2026-06-02T10:01:00Z', attributionSkill: 'jira' }),
    ]);

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const expected = sumMessages(db, 'skill_rollup');
    expect(expected).toBe(2);

    // On efface le grain skill en laissant `seen_messages` intact, comme sur une vraie base.
    db.prepare('DELETE FROM skill_rollup').run();
    db.prepare('DELETE FROM seen_skill_messages').run();
    db.prepare("DELETE FROM meta WHERE key = 'skills_backfilled'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM seen_messages').get()).toEqual({ n: 2 });

    const result = ingest(db, projectsDir);
    expect(result.skillsBackfilled).toBe(true);
    expect(sumMessages(db, 'skill_rollup')).toBe(expected);
    // Le grain session, lui, ne doit PAS avoir été recompté.
    expect(sumMessages(db, 'usage_rollup')).toBe(2);
  });

  it('ne compte pas deux fois après une ré-ingestion forcée', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', timestamp: '2026-06-02T10:00:00Z', attributionSkill: 'epct' }),
    ]);
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    ingest(db, projectsDir, { force: true });
    ingest(db, projectsDir, { force: true });
    expect(sumMessages(db, 'skill_rollup')).toBe(1);
  });
});

describe('grain skill — filiation et pipelines', () => {
  it('relève l’arête appelant → appelé et fait remonter la racine', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', timestamp: '2026-06-02T10:00:00Z', attributionSkill: 'epct-sexy' }),
      // La ligne qui ÉMET l'invocation porte encore l'appelant : c'est ce décalage qui donne l'arête.
      toolUseLine({
        id: 'm1',
        requestId: 'r1',
        timestamp: '2026-06-02T10:00:00Z',
        attributionSkill: 'epct-sexy',
        toolUseId: 'toolu_1',
        toolName: 'Skill',
        input: { skill: 'epct' },
      }),
      assistantEvent({ id: 'm2', requestId: 'r2', timestamp: '2026-06-02T10:01:00Z', attributionSkill: 'epct' }),
    ]);

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);

    expect(getSkillEdges(db)).toEqual([
      { sessionId: 'sess1', childSkill: 'epct', parentSkill: 'epct-sexy' },
    ]);

    const report = aggregateSkills(getSkillUsage(db), getSkillEdges(db), buildResolver());
    const epct = report.rows.find((r) => r.skill === 'epct');
    expect(epct?.rootSkill).toBe('epct-sexy');
    expect(report.pipelines.map((p) => p.key)).toEqual(['epct-sexy']);
  });

  it('n’enregistre PAS d’arête pour une invocation de premier niveau', () => {
    // Sans `attributionSkill` sur la ligne émettrice, il n'y a pas de parent : l'enfant EST la
    // racine. Inventer un parent « (hors skill) » donnerait un pipeline faux.
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      toolUseLine({
        id: 'm1',
        requestId: 'r1',
        timestamp: '2026-06-02T10:00:00Z',
        toolUseId: 'toolu_1',
        toolName: 'Skill',
        input: { skill: 'voice' },
      }),
      assistantEvent({ id: 'm2', requestId: 'r2', timestamp: '2026-06-02T10:01:00Z', attributionSkill: 'voice' }),
    ]);

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);

    expect(getSkillEdges(db)).toEqual([]);
    const report = aggregateSkills(getSkillUsage(db), getSkillEdges(db), buildResolver());
    expect(report.rows.find((r) => r.skill === 'voice')?.rootSkill).toBe('voice');
  });

  it('ignore une arête réflexive, qui évincerait la vraie', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      // `voice` se réinvoque : aucune information, et cette arête occuperait la clé primaire.
      toolUseLine({
        id: 'm1',
        requestId: 'r1',
        timestamp: '2026-06-02T10:00:00Z',
        attributionSkill: 'voice',
        toolUseId: 'toolu_1',
        toolName: 'Skill',
        input: { skill: 'voice' },
      }),
      toolUseLine({
        id: 'm2',
        requestId: 'r2',
        timestamp: '2026-06-02T10:01:00Z',
        attributionSkill: 'kran',
        toolUseId: 'toolu_2',
        toolName: 'Skill',
        input: { skill: 'voice' },
      }),
      assistantEvent({ id: 'm3', requestId: 'r3', timestamp: '2026-06-02T10:02:00Z', attributionSkill: 'voice' }),
    ]);

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    expect(getSkillEdges(db)).toEqual([
      { sessionId: 'sess1', childSkill: 'voice', parentSkill: 'kran' },
    ]);
  });
});

describe('resolveRootSkill', () => {
  it('remonte une chaîne de plusieurs niveaux', () => {
    const parents = indexSkillEdges([
      { sessionId: 's', childSkill: 'c', parentSkill: 'b' },
      { sessionId: 's', childSkill: 'b', parentSkill: 'a' },
    ]);
    expect(resolveRootSkill(parents.get('s'), 'c')).toBe('a');
  });

  it('renvoie le skill lui-même sans arête connue', () => {
    expect(resolveRootSkill(undefined, 'epct')).toBe('epct');
    expect(resolveRootSkill(new Map(), 'epct')).toBe('epct');
  });

  it('ne boucle pas sur un cycle', () => {
    const parents = new Map([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(['a', 'b']).toContain(resolveRootSkill(parents, 'a'));
  });
});
