import { describe, expect, it } from 'vitest';
import { buildSeries, renderChart, weekStart } from '../src/web/timeseries.js';
import { zeroUsage, type UsageCounts } from '../src/pricing/cost-model.js';
import type { CostedRow } from '../src/report/aggregate.js';

/** Construit une ligne coûtée de test pour un jour donné. */
function dayRow(day: string, cost: number): CostedRow {
  const counts: UsageCounts = { ...zeroUsage(), input: 1000 };
  return { key: day, messageCount: 1, counts, cost };
}

describe('weekStart', () => {
  it('ramène une date au lundi de sa semaine', () => {
    // 2026-06-10 est un mercredi → lundi = 2026-06-08
    expect(weekStart('2026-06-10')).toBe('2026-06-08');
    // un lundi reste inchangé
    expect(weekStart('2026-06-08')).toBe('2026-06-08');
  });
});

describe('buildSeries', () => {
  it('produit une série quotidienne triée chronologiquement', () => {
    const series = buildSeries([dayRow('2026-06-10', 5), dayRow('2026-06-08', 3)], 'day');
    expect(series.map((p) => p.label)).toEqual(['2026-06-08', '2026-06-10']);
    expect(series[1].cost).toBe(5);
  });

  it('agrège par semaine', () => {
    const series = buildSeries(
      [dayRow('2026-06-08', 3), dayRow('2026-06-10', 5), dayRow('2026-06-15', 2)],
      'week',
    );
    // 08 et 10 → même semaine (lundi 08) ; 15 → semaine suivante
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ label: '2026-06-08', cost: 8 });
    expect(series[1]).toMatchObject({ label: '2026-06-15', cost: 2 });
  });

  it('ignore les jours « unknown »', () => {
    const series = buildSeries([dayRow('unknown', 9), dayRow('2026-06-10', 1)], 'day');
    expect(series).toHaveLength(1);
  });
});

describe('renderChart', () => {
  it('rend un SVG avec des barres', () => {
    const svg = renderChart(buildSeries([dayRow('2026-06-10', 5)], 'day'), 'day');
    expect(svg).toContain('<svg');
    expect(svg).toContain('class="cbar"');
  });

  it('affiche un message si la série est vide', () => {
    expect(renderChart([], 'day')).toContain('Aucune donnée');
  });
});
