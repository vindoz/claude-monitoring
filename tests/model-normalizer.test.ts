import { describe, expect, it } from 'vitest';
import {
  billingModelId,
  isSyntheticModel,
  modelFamily,
  normalizeModelId,
  splitFastMode,
} from '../src/pricing/model-normalizer.js';

describe('fast mode', () => {
  it('suffixe la clé de facturation uniquement pour speed = fast', () => {
    expect(billingModelId('claude-opus-5-5', 'fast')).toBe('claude-opus-5-5@fast');
    expect(billingModelId('claude-opus-5-5', 'standard')).toBe('claude-opus-5-5');
    expect(billingModelId('claude-opus-5-5', undefined)).toBe('claude-opus-5-5');
  });

  it('sépare base et indicateur, date comprise', () => {
    expect(splitFastMode('claude-opus-5-5@fast')).toEqual({ base: 'claude-opus-5-5', fast: true });
    expect(splitFastMode('claude-opus-4-8-20260101@fast')).toEqual({ base: 'claude-opus-4-8-20260101', fast: true });
    expect(splitFastMode('claude-opus-5-5')).toEqual({ base: 'claude-opus-5-5', fast: false });
  });
});

describe('normalizeModelId', () => {
  it('retire un suffixe de date YYYYMMDD', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  });

  it('laisse intact un id sans suffixe de date', () => {
    expect(normalizeModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
    // Le `-1` de Fable 5.1 n'est pas une date : il ne doit pas être rogné.
    expect(normalizeModelId('claude-fable-5-1')).toBe('claude-fable-5-1');
    expect(normalizeModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
  });
});

describe('modelFamily', () => {
  it('reconnaît les familles à partir d’ids complets', () => {
    expect(modelFamily('claude-opus-4-8')).toBe('opus');
    expect(modelFamily('claude-opus-5-5')).toBe('opus');
    expect(modelFamily('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelFamily('claude-haiku-4-5')).toBe('haiku');
    expect(modelFamily('claude-fable-5')).toBe('fable');
    expect(modelFamily('claude-fable-5-1')).toBe('fable');
  });

  it('reconnaît les alias nus', () => {
    expect(modelFamily('opus')).toBe('opus');
    expect(modelFamily('SONNET')).toBe('sonnet');
  });

  it('renvoie null pour un modèle inconnu', () => {
    expect(modelFamily('gpt-4')).toBeNull();
  });
});

describe('isSyntheticModel', () => {
  it('détecte les events synthétiques', () => {
    expect(isSyntheticModel('<synthetic>')).toBe(true);
    expect(isSyntheticModel('claude-opus-4-8')).toBe(false);
  });
});
