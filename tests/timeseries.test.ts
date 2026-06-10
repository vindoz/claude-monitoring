import { describe, expect, it } from 'vitest';
import {
  buildStackedSeries,
  projectLabel,
  renderStackedChart,
  weekStart,
} from '../src/web/timeseries.js';
import type { DayProjectCost } from '../src/report/aggregate.js';

/** Construit une cellule (jour, projet) coûtée de test. */
function cell(day: string, project: string, cost: number, messageCount = 1): DayProjectCost {
  return { day, project, cost, messageCount };
}

describe('weekStart', () => {
  it('ramène une date au lundi de sa semaine', () => {
    // 2026-06-10 est un mercredi → lundi = 2026-06-08
    expect(weekStart('2026-06-10')).toBe('2026-06-08');
    // un lundi reste inchangé
    expect(weekStart('2026-06-08')).toBe('2026-06-08');
  });
});

describe('projectLabel', () => {
  it('extrait le segment après -projets-', () => {
    expect(projectLabel('-home-mbaron-projets-claude-monitoring')).toBe('claude-monitoring');
  });
  it('retire le tiret de tête à défaut de marqueur', () => {
    expect(projectLabel('-tmp-demo')).toBe('tmp-demo');
  });
  it('libelle le regroupement « Autres »', () => {
    expect(projectLabel('__other__')).toBe('Autres');
  });
});

describe('buildStackedSeries', () => {
  it('empile les projets par barre, classés par coût total décroissant', () => {
    const rows = [
      cell('2026-06-10', '-A', 5),
      cell('2026-06-10', '-B', 2),
      cell('2026-06-10', '-A', 5), // deux contributions au même couple (jour, projet)
    ];
    const series = buildStackedSeries(rows, 'day');
    expect(series.projects.map((p) => p.project)).toEqual(['-A', '-B']);
    expect(series.points).toHaveLength(1);
    const point = series.points[0];
    expect(point.cost).toBeCloseTo(12, 5);
    // Segments dans l'ordre d'empilement global (A le plus coûteux d'abord).
    expect(point.segments.map((s) => s.project)).toEqual(['-A', '-B']);
    expect(point.segments[0].cost).toBeCloseTo(10, 5);
  });

  it('agrège par semaine en fusionnant les jours', () => {
    const rows = [
      cell('2026-06-08', '-A', 3),
      cell('2026-06-10', '-A', 5),
      cell('2026-06-15', '-A', 2),
    ];
    const series = buildStackedSeries(rows, 'week');
    expect(series.points).toHaveLength(2);
    expect(series.points[0]).toMatchObject({ label: '2026-06-08', cost: 8 });
    expect(series.points[1]).toMatchObject({ label: '2026-06-15', cost: 2 });
  });

  it('regroupe les projets au-delà du maximum sous « Autres »', () => {
    const rows = [
      cell('2026-06-10', '-A', 10),
      cell('2026-06-10', '-B', 5),
      cell('2026-06-10', '-C', 1),
    ];
    const series = buildStackedSeries(rows, 'day', 2);
    expect(series.projects.map((p) => p.project)).toEqual(['-A', '-B', '__other__']);
    const other = series.points[0].segments.find((s) => s.project === '__other__');
    expect(other?.cost).toBeCloseTo(1, 5);
  });

  it('ignore les jours « unknown »', () => {
    const series = buildStackedSeries([cell('unknown', '-A', 9), cell('2026-06-10', '-A', 1)], 'day');
    expect(series.points).toHaveLength(1);
    expect(series.points[0].cost).toBeCloseTo(1, 5);
  });
});

describe('renderStackedChart', () => {
  it('rend un SVG avec des segments empilés', () => {
    const series = buildStackedSeries([cell('2026-06-10', '-A', 5), cell('2026-06-10', '-B', 2)], 'day');
    const svg = renderStackedChart(series, 'day');
    expect(svg).toContain('<svg');
    expect(svg).toContain('class="seg"');
    expect(svg).toContain('<title>');
  });

  it('affiche un message si la série est vide', () => {
    expect(renderStackedChart({ points: [], projects: [] }, 'day')).toContain('Aucune donnée');
  });
});
