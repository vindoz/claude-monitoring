import { describe, expect, it } from 'vitest';
import {
  addUsage,
  costOf,
  totalTokens,
  usageFromClaude,
  zeroUsage,
} from '../src/pricing/cost-model.js';
import type { ModelPricing } from '../src/pricing/default-pricing.js';

const PRICING: ModelPricing = {
  input: 10,
  output: 50,
  cacheWrite5m: 12.5,
  cacheWrite1h: 20,
  cacheRead: 1,
  webSearchPerThousand: 10,
};

describe('usageFromClaude', () => {
  it('extrait les compteurs de base', () => {
    const counts = usageFromClaude({
      input_tokens: 100,
      cache_read_input_tokens: 200,
      output_tokens: 50,
    });
    expect(counts.input).toBe(100);
    expect(counts.cacheRead).toBe(200);
    expect(counts.output).toBe(50);
  });

  it('ventile le cache 5m / 1h quand le détail est présent', () => {
    const counts = usageFromClaude({
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
    });
    expect(counts.cacheWrite5m).toBe(600);
    expect(counts.cacheWrite1h).toBe(400);
  });

  it('impute tout au tarif 5m sans détail de ventilation', () => {
    const counts = usageFromClaude({ cache_creation_input_tokens: 1000 });
    expect(counts.cacheWrite5m).toBe(1000);
    expect(counts.cacheWrite1h).toBe(0);
  });

  it('retombe sur 5m si le détail est présent mais vide', () => {
    const counts = usageFromClaude({
      cache_creation_input_tokens: 800,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    });
    expect(counts.cacheWrite5m).toBe(800);
  });

  it('gère un usage absent', () => {
    expect(usageFromClaude(undefined)).toEqual(zeroUsage());
  });
});

describe('costOf', () => {
  it('calcule le coût par composante (par MTok)', () => {
    const cost = costOf(
      { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, webSearch: 0, webFetch: 0 },
      PRICING,
    );
    expect(cost).toBeCloseTo(10, 6);
  });

  it('additionne toutes les composantes et les requêtes web', () => {
    const cost = costOf(
      {
        input: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
        webSearch: 1000,
        webFetch: 0,
      },
      PRICING,
    );
    // 10 + 12.5 + 20 + 1 + 50 (tokens) + 10 (1000 web searches)
    expect(cost).toBeCloseTo(103.5, 6);
  });
});

describe('addUsage / totalTokens', () => {
  it('additionne deux jeux de compteurs', () => {
    const a = { input: 1, cacheWrite5m: 2, cacheWrite1h: 3, cacheRead: 4, output: 5, webSearch: 6, webFetch: 7 };
    const sum = addUsage(a, a);
    expect(sum.input).toBe(2);
    expect(sum.output).toBe(10);
  });

  it('totalTokens ne compte pas les requêtes web', () => {
    const counts = { input: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, output: 1, webSearch: 99, webFetch: 99 };
    expect(totalTokens(counts)).toBe(5);
  });
});
