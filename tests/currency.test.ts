import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatPercent,
  formatTokens,
  formatUsd,
} from '../src/format/currency.js';
import { progressBar } from '../src/format/tables.js';

describe('formatUsd', () => {
  it('formate zéro', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });
  it('formate les petits montants avec plus de décimales', () => {
    expect(formatUsd(0.0012)).toBe('$0.0012');
  });
  it('formate les montants courants', () => {
    expect(formatUsd(12.345)).toBe('$12.35');
  });
});

describe('formatTokens', () => {
  it('formate en unités', () => {
    expect(formatTokens(500)).toBe('500');
  });
  it('formate en milliers', () => {
    expect(formatTokens(1500)).toBe('1.5k');
  });
  it('formate en millions', () => {
    expect(formatTokens(2_500_000)).toBe('2.50M');
  });
});

describe('formatPercent', () => {
  it('formate un pourcentage', () => {
    expect(formatPercent(33.33, 1)).toBe('33.3%');
  });
});

describe('formatDateTime', () => {
  it('renvoie un tiret sans valeur', () => {
    expect(formatDateTime(null)).toBe('—');
  });
  it('formate un horodatage', () => {
    expect(formatDateTime(Date.parse('2026-06-10T13:45:00Z'))).toBe('2026-06-10 13:45');
  });
});

describe('progressBar', () => {
  it('borne les valeurs hors intervalle', () => {
    expect(progressBar(0, 10)).toBe('░░░░░░░░░░');
    expect(progressBar(100, 10)).toBe('▓▓▓▓▓▓▓▓▓▓');
    expect(progressBar(150, 10)).toBe('▓▓▓▓▓▓▓▓▓▓');
  });
});
