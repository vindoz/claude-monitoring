import { describe, expect, it } from 'vitest';
import {
  aggregateDayProject,
  aggregateDimension,
  aggregateSessions,
} from '../src/report/aggregate.js';
import { createResolver, loadPricingTable } from '../src/pricing/pricing-loader.js';
import type { DayProjectUsageRow, DimensionUsageRow, SessionMeta } from '../src/db/queries.js';

const resolver = createResolver(loadPricingTable());

/** Construit une ligne d'usage de test. */
function row(key: string, model: string, input: number, output: number): DimensionUsageRow {
  return {
    key,
    model,
    messageCount: 1,
    counts: { input, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output, webSearch: 0, webFetch: 0 },
  };
}

describe('aggregateDimension', () => {
  it('agrège par clé, calcule le coût par modèle et trie par coût décroissant', () => {
    const rows = [
      row('A', 'claude-opus-4-8', 1_000_000, 0), // 5 $
      row('A', 'claude-haiku-4-5', 1_000_000, 0), // 1 $
      row('B', 'claude-opus-4-8', 2_000_000, 0), // 10 $
    ];
    const report = aggregateDimension(rows, resolver);
    expect(report.rows[0].key).toBe('B');
    expect(report.rows[0].cost).toBeCloseTo(10, 5);
    expect(report.rows[1].key).toBe('A');
    expect(report.rows[1].cost).toBeCloseTo(6, 5);
    expect(report.total.cost).toBeCloseTo(16, 5);
  });

  it('signale les modèles non tarifés ayant consommé des tokens', () => {
    const report = aggregateDimension([row('A', 'gpt-4', 1000, 0)], resolver);
    expect(report.unknownModels).toContain('gpt-4');
  });
});

describe('aggregateDayProject', () => {
  /** Construit une ligne (jour, projet, modèle) de test. */
  function dpRow(day: string, project: string, model: string, input: number): DayProjectUsageRow {
    return {
      day,
      project,
      model,
      messageCount: 1,
      counts: { input, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, webSearch: 0, webFetch: 0 },
    };
  }

  it('somme le coût par (jour, projet) en cumulant les modèles', () => {
    const rows = [
      dpRow('2026-06-01', '-A', 'claude-opus-4-8', 1_000_000), // 5 $
      dpRow('2026-06-01', '-A', 'claude-haiku-4-5', 1_000_000), // 1 $
      dpRow('2026-06-01', '-B', 'claude-opus-4-8', 1_000_000), // 5 $
    ];
    const cells = aggregateDayProject(rows, resolver);
    const a = cells.find((c) => c.project === '-A');
    const b = cells.find((c) => c.project === '-B');
    expect(a?.cost).toBeCloseTo(6, 5);
    expect(a?.messageCount).toBe(2);
    expect(b?.cost).toBeCloseTo(5, 5);
  });
});

describe('aggregateSessions', () => {
  const metas: SessionMeta[] = [
    { sessionId: 's1', projectSlug: '-p', cwd: '/p', title: 'T1', firstTs: 100, lastTs: 200, gitBranch: 'main' },
    { sessionId: 's2', projectSlug: '-p', cwd: '/p', title: 'T2', firstTs: 300, lastTs: 400, gitBranch: 'main' },
  ];

  it('combine usage et métadonnées, trie par dernière activité', () => {
    const usage = [row('s1', 'claude-opus-4-8', 1_000_000, 0), row('s2', 'claude-haiku-4-5', 1_000_000, 0)];
    const report = aggregateSessions(usage, metas, resolver);
    expect(report.rows[0].meta.sessionId).toBe('s2'); // lastTs plus récent
    expect(report.rows[1].models).toEqual(['claude-opus-4-8']);
    expect(report.total.cost).toBeCloseTo(6, 5);
  });

  it('gère une session sans métadonnées', () => {
    const report = aggregateSessions([row('orpheline', 'claude-opus-4-8', 1000, 0)], [], resolver);
    expect(report.rows[0].meta.projectSlug).toBe('');
  });
});
