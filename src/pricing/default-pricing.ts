/**
 * Grille tarifaire par défaut, exprimée en dollars (USD) par **million de tokens** (MTok),
 * sauf `webSearchPerThousand` / `webFetchPerThousand` exprimés par millier de requêtes.
 *
 * Source : tarifs publics Anthropic (platform.claude.com/docs/en/about-claude/pricing,
 * relevés le 2026-09-02, tiers standard, prompt caching inclus) :
 * - Fable 5.1 : 10 $ / 50 $, mêmes prix de base que Fable 5 mais lecture de cache au quart ;
 * - Fable 5 : 10 $ / 50 $ (soit 2× Opus 5) ;
 * - Opus 4.5 → 5 : 5 $ / 25 $ (le tarif 15 $ / 75 $ ne concerne que les anciens Opus 4 / 4.1) ;
 * - Sonnet 5 : 2 $ / 10 $ (tarif dit « introductif », devenu le tarif standard) ;
 * - Sonnet 4.5 / 4.6 : 3 $ / 15 $ ; Haiku 4.5 : 1 $ / 5 $.
 *
 * Les multiplicateurs de cache suivent la règle Anthropic : écriture 5 min = 1,25 × input,
 * écriture 1 h = 2 × input, lecture = 0,1 × input. **Fable 5.1 en est la seule exception** : sa
 * lecture de cache vaut 0,025 × input, abattement que la documentation n'étend à aucun autre
 * modèle (hors Mythos 5.1, réservé à Project Glasswing et absent de cette grille).
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

/** Sonnet 5 : un tiers moins cher que les Sonnet 4.x, qu'il remplace. */
const SONNET_5: ModelPricing = {
  input: 2,
  output: 10,
  cacheWrite5m: 2.5,
  cacheWrite1h: 4,
  cacheRead: 0.2,
  webSearchPerThousand: 10,
};

/** Sonnet 4 / 4.5 / 4.6, restés au tarif de leur génération. */
const SONNET_4: ModelPricing = {
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

/**
 * Fable 5.1 : mêmes prix de base et mêmes écritures de cache que Fable 5, mais **lecture de
 * cache à 0,25 $** — soit 0,025 × input au lieu du 0,1 × universel. C'est le seul écart à la
 * règle dans toute la grille ; il est nominatif et ne s'hérite pas (cf. `FAMILY_PRICING`).
 */
const FABLE_5_1: ModelPricing = {
  input: 10,
  output: 50,
  cacheWrite5m: 12.5,
  cacheWrite1h: 20,
  cacheRead: 0.25,
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
  'claude-opus-5': OPUS,
  'claude-opus-4-8': OPUS,
  'claude-opus-4-7': OPUS,
  'claude-opus-4-6': OPUS,
  'claude-opus-4-5': OPUS,
  'claude-opus-4-1': OPUS_LEGACY,
  'claude-opus-4-0': OPUS_LEGACY,
  // Forme canonique de l'id complet `claude-opus-4-20250514` (suffixe de date retiré).
  'claude-opus-4': OPUS_LEGACY,
  'claude-sonnet-5': SONNET_5,
  'claude-sonnet-4-6': SONNET_4,
  'claude-sonnet-4-5': SONNET_4,
  'claude-haiku-4-5': HAIKU,
  'claude-fable-5-1': FABLE_5_1,
  'claude-fable-5': FABLE,
};

/**
 * Tarification de repli par famille : le tarif de la génération COURANTE de chaque famille,
 * appliqué à tout identifiant dépourvu d'entrée exacte (alias nu `opus`, modèle plus récent
 * que cette grille).
 *
 * Deux conséquences assumées :
 * - un identifiant ANCIEN sans entrée exacte est sous-tarifé — un `claude-3-5-sonnet-*` compterait
 *   2 $ / 10 $ au lieu de 3 $ / 15 $, comme un `claude-3-opus` compterait 5 $ / 25 $ au lieu de
 *   15 $ / 75 $. Le repli sert les modèles à venir, pas les modèles retirés ;
 * - la famille `fable` reste sur le tarif Fable 5 (lecture de cache à 1 $) : l'abattement de
 *   Fable 5.1 est nominatif, l'étendre à un futur `claude-fable-5-2` serait une supposition.
 */
export const FAMILY_PRICING: Record<string, ModelPricing> = {
  opus: OPUS,
  sonnet: SONNET_5,
  haiku: HAIKU,
  fable: FABLE,
};
