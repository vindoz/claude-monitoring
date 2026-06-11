import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createResolver,
  loadOverrideFile,
  loadPricingTable,
} from '../src/pricing/pricing-loader.js';
import { DEFAULT_PRICING } from '../src/pricing/default-pricing.js';
import { makeTempDir } from './helpers.js';

describe('createResolver', () => {
  const resolver = createResolver(loadPricingTable());

  it('résout un id exact', () => {
    const r = resolver.resolve('claude-opus-4-8');
    expect(r.match).toBe('exact');
    expect(r.pricing.input).toBe(15);
  });

  it('résout un id avec suffixe de date via la forme canonique', () => {
    const r = resolver.resolve('claude-haiku-4-5-20251001');
    expect(r.match).toBe('exact');
    expect(r.canonical).toBe('claude-haiku-4-5');
    expect(r.pricing.input).toBe(1);
  });

  it('applique le tarif Fable 5 (2× Opus 4.8)', () => {
    const r = resolver.resolve('claude-fable-5');
    expect(r.pricing.input).toBe(30);
    expect(r.pricing.output).toBe(150);
    expect(r.pricing.cacheRead).toBe(3);
  });

  it('retombe sur la famille pour un alias nu', () => {
    const r = resolver.resolve('opus');
    expect(r.match).toBe('family');
    expect(r.pricing.input).toBe(15);
  });

  it('traite les events synthétiques comme gratuits', () => {
    const r = resolver.resolve('<synthetic>');
    expect(r.match).toBe('synthetic');
    expect(r.pricing.input).toBe(0);
  });

  it('signale un modèle inconnu (tarif gratuit)', () => {
    const r = resolver.resolve('gpt-4');
    expect(r.match).toBe('unknown');
    expect(r.pricing.input).toBe(0);
  });
});

describe('override de pricing', () => {
  it('fusionne et surcharge la grille par défaut', () => {
    const dir = makeTempDir();
    const file = join(dir, 'pricing.json');
    writeFileSync(
      file,
      JSON.stringify({
        'claude-fable-5': { input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.8 },
      }),
    );
    const table = loadPricingTable(file);
    expect(table['claude-fable-5'].input).toBe(8);
    // les autres modèles restent inchangés
    expect(table['claude-opus-4-8'].input).toBe(DEFAULT_PRICING['claude-opus-4-8'].input);
  });

  it('renvoie un objet vide si le fichier est absent', () => {
    expect(loadOverrideFile(join(makeTempDir(), 'inexistant.json'))).toEqual({});
  });

  it('rejette un override invalide', () => {
    const dir = makeTempDir();
    const file = join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ 'claude-opus-4-8': { input: 'cher' } }));
    expect(() => loadOverrideFile(file)).toThrow();
  });
});
