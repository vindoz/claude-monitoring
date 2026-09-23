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
    expect(r.pricing.input).toBe(5);
  });

  it('résout un id avec suffixe de date via la forme canonique', () => {
    const r = resolver.resolve('claude-haiku-4-5-20251001');
    expect(r.match).toBe('exact');
    expect(r.canonical).toBe('claude-haiku-4-5');
    expect(r.pricing.input).toBe(1);
  });

  it('applique le tarif Fable 5 (2× Opus 4.8)', () => {
    const r = resolver.resolve('claude-fable-5');
    expect(r.pricing.input).toBe(10);
    expect(r.pricing.output).toBe(50);
    expect(r.pricing.cacheRead).toBe(1);
  });

  it('applique le tarif Fable 5.1 : mêmes prix de base, lecture de cache au quart', () => {
    const r = resolver.resolve('claude-fable-5-1');
    expect(r.match).toBe('exact');
    expect(r.pricing.input).toBe(10);
    expect(r.pricing.output).toBe(50);
    expect(r.pricing.cacheWrite5m).toBe(12.5);
    expect(r.pricing.cacheWrite1h).toBe(20);
    // Seul modèle de la grille dont la lecture vaut 0,025 × input au lieu de 0,1 × input.
    expect(r.pricing.cacheRead).toBe(0.25);
  });

  it('applique le tarif Opus 5.5 : 20 % sous Opus 5, lecture de cache à 0,05 × input', () => {
    const r = resolver.resolve('claude-opus-5-5');
    expect(r.match).toBe('exact');
    expect(r.pricing.input).toBe(4);
    expect(r.pricing.output).toBe(20);
    expect(r.pricing.cacheWrite5m).toBe(5);
    expect(r.pricing.cacheWrite1h).toBe(8);
    expect(r.pricing.cacheRead).toBe(0.2);
  });

  it('double tout le tarif en fast mode, cache compris, sans toucher au web', () => {
    const r = resolver.resolve('claude-opus-5-5@fast');
    expect(r.match).toBe('exact');
    expect(r.canonical).toBe('claude-opus-5-5@fast');
    expect(r.pricing).toMatchObject({ input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.4 });
    expect(r.pricing.webSearchPerThousand).toBe(10);
    // Opus 5 / 4.8 : 10 $ / 50 $ selon la grille publique.
    expect(resolver.resolve('claude-opus-4-8@fast').pricing).toMatchObject({ input: 10, output: 50 });
  });

  it('garde la nature de correspondance du modèle de base en fast mode', () => {
    const family = resolver.resolve('claude-opus-9@fast');
    expect(family.match).toBe('family');
    expect(family.pricing.input).toBe(8);
    expect(resolver.resolve('gpt-5@fast').match).toBe('unknown');
  });

  it('préfère une surcharge `@fast` explicite, même depuis un id daté', () => {
    const fastOverride = { input: 7, output: 35, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
    const custom = createResolver({ ...DEFAULT_PRICING, 'claude-opus-5-5@fast': fastOverride });
    const r = custom.resolve('claude-opus-5-5-20260922@fast');
    expect(r.match).toBe('exact');
    expect(r.pricing.input).toBe(7);
  });

  it('tarife Opus 5 et Sonnet 5 par correspondance exacte, pas par repli de famille', () => {
    const opus5 = resolver.resolve('claude-opus-5');
    expect(opus5.match).toBe('exact');
    expect(opus5.pricing.input).toBe(5);
    expect(opus5.pricing.output).toBe(25);
    expect(opus5.pricing.cacheRead).toBe(0.5);

    const sonnet5 = resolver.resolve('claude-sonnet-5');
    expect(sonnet5.match).toBe('exact');
    expect(sonnet5.pricing.input).toBe(2);
    expect(sonnet5.pricing.output).toBe(10);
    expect(sonnet5.pricing.cacheRead).toBe(0.2);
  });

  it('laisse les Sonnet 4.x au tarif de leur génération', () => {
    const r = resolver.resolve('claude-sonnet-4-6');
    expect(r.match).toBe('exact');
    expect(r.pricing.input).toBe(3);
    expect(r.pricing.output).toBe(15);
  });

  it('replie un alias de famille sur la génération courante', () => {
    const r = resolver.resolve('sonnet');
    expect(r.match).toBe('family');
    expect(r.pricing.input).toBe(2);
  });

  it('applique le tarif historique aux anciens Opus 4 / 4.1', () => {
    expect(resolver.resolve('claude-opus-4-1-20250805').pricing.input).toBe(15);
    expect(resolver.resolve('claude-opus-4-20250514').pricing.input).toBe(15);
  });

  it('retombe sur la famille pour un alias nu', () => {
    const r = resolver.resolve('opus');
    expect(r.match).toBe('family');
    // Prix de base d'Opus 5.5, génération courante…
    expect(r.pricing.input).toBe(4);
    expect(r.pricing.output).toBe(20);
    // …mais sans son abattement de lecture, qui est nominatif : 0,1 × input.
    expect(r.pricing.cacheRead).toBe(0.4);
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
