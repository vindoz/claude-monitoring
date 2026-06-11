/**
 * Grille tarifaire par défaut, exprimée en dollars (USD) par **million de tokens** (MTok),
 * sauf `webSearchPerThousand` / `webFetchPerThousand` exprimés par millier de requêtes.
 *
 * Source : tarifs publics Anthropic (platform.claude.com/docs/en/about-claude/pricing,
 * relevés le 2026-06-11, tiers standard, prompt caching inclus) :
 * - Opus 4.5 → 4.8 : 5 $ / 25 $ (le tarif 15 $ / 75 $ ne concerne que les anciens Opus 4 / 4.1) ;
 * - Fable 5 : 10 $ / 50 $ (soit 2× Opus 4.8) ;
 * - Sonnet 4.5 / 4.6 : 3 $ / 15 $ ; Haiku 4.5 : 1 $ / 5 $.
 *
 * Les multiplicateurs de cache suivent la règle Anthropic : écriture 5 min = 1,25 × input,
 * écriture 1 h = 2 × input, lecture = 0,1 × input.
 */

/** Tarification d'un modèle (USD par MTok, sauf requêtes web par millier). */
export interface ModelPricing {
  /** Tokens d'entrée frais. */
  input: number;
  /** Tokens de sortie. */
  output: number;
  /** Écriture cache éphémère 5 minutes. */
  cacheWrite5m: number;
  /** Écriture cache éphémère 1 heure. */
  cacheWrite1h: number;
  /** Lecture cache. */
  cacheRead: number;
  /** Coût pour 1000 requêtes de recherche web (server tool). */
  webSearchPerThousand?: number;
  /** Coût pour 1000 requêtes de fetch web (server tool). */
  webFetchPerThousand?: number;
}

const OPUS: ModelPricing = {
  input: 5,
  output: 25,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
  cacheRead: 0.5,
  webSearchPerThousand: 10,
};

/** Anciens Opus 4 / 4.1 (dépréciés), seuls modèles restés au tarif historique. */
const OPUS_LEGACY: ModelPricing = {
  input: 15,
  output: 75,
  cacheWrite5m: 18.75,
  cacheWrite1h: 30,
  cacheRead: 1.5,
  webSearchPerThousand: 10,
};

const SONNET: ModelPricing = {
  input: 3,
  output: 15,
  cacheWrite5m: 3.75,
  cacheWrite1h: 6,
  cacheRead: 0.3,
  webSearchPerThousand: 10,
};

const HAIKU: ModelPricing = {
  input: 1,
  output: 5,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  cacheRead: 0.1,
  webSearchPerThousand: 10,
};

const FABLE: ModelPricing = {
  input: 10,
  output: 50,
  cacheWrite5m: 12.5,
  cacheWrite1h: 20,
  cacheRead: 1,
  webSearchPerThousand: 10,
};

/** Tarif d'un modèle entièrement gratuit (events `<synthetic>`). */
export const FREE_PRICING: ModelPricing = {
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
};

/** Tarification par identifiant de modèle canonique (suffixe de date retiré). */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-8': OPUS,
  'claude-opus-4-7': OPUS,
  'claude-opus-4-6': OPUS,
  'claude-opus-4-5': OPUS,
  'claude-opus-4-1': OPUS_LEGACY,
  'claude-opus-4-0': OPUS_LEGACY,
  // Forme canonique de l'id complet `claude-opus-4-20250514` (suffixe de date retiré).
  'claude-opus-4': OPUS_LEGACY,
  'claude-sonnet-4-6': SONNET,
  'claude-sonnet-4-5': SONNET,
  'claude-haiku-4-5': HAIKU,
  'claude-fable-5': FABLE,
};

/** Tarification de repli par famille de modèle. */
export const FAMILY_PRICING: Record<string, ModelPricing> = {
  opus: OPUS,
  sonnet: SONNET,
  haiku: HAIKU,
  fable: FABLE,
};
