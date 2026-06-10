import type { ClaudeUsage } from '../types/claude-events.js';
import type { ModelPricing } from './default-pricing.js';

/** Tokens d'un usage ventilés par catégorie de facturation. */
export interface UsageCounts {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  webSearch: number;
  webFetch: number;
}

/** Compteurs d'usage à zéro (élément neutre pour les agrégations). */
export function zeroUsage(): UsageCounts {
  return {
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    webSearch: 0,
    webFetch: 0,
  };
}

/**
 * Extrait les compteurs de facturation d'un objet `usage` Claude.
 * L'écriture de cache est ventilée 5 min / 1 h via `cache_creation` quand le détail est présent ;
 * sinon la totalité est imputée au tarif 5 min (cas le plus fréquent).
 */
export function usageFromClaude(usage: ClaudeUsage | undefined): UsageCounts {
  const counts = zeroUsage();
  if (!usage) {
    return counts;
  }

  counts.input = usage.input_tokens ?? 0;
  counts.cacheRead = usage.cache_read_input_tokens ?? 0;
  counts.output = usage.output_tokens ?? 0;

  const totalWrite = usage.cache_creation_input_tokens ?? 0;
  const breakdown = usage.cache_creation;
  if (
    breakdown &&
    (breakdown.ephemeral_5m_input_tokens != null || breakdown.ephemeral_1h_input_tokens != null)
  ) {
    counts.cacheWrite5m = breakdown.ephemeral_5m_input_tokens ?? 0;
    counts.cacheWrite1h = breakdown.ephemeral_1h_input_tokens ?? 0;
    // Détail présent mais vide alors que le total ne l'est pas : on impute au tarif 5 min.
    if (counts.cacheWrite5m + counts.cacheWrite1h === 0 && totalWrite > 0) {
      counts.cacheWrite5m = totalWrite;
    }
  } else {
    counts.cacheWrite5m = totalWrite;
  }

  counts.webSearch = usage.server_tool_use?.web_search_requests ?? 0;
  counts.webFetch = usage.server_tool_use?.web_fetch_requests ?? 0;
  return counts;
}

/** Additionne deux jeux de compteurs (pour agréger des usages). */
export function addUsage(a: UsageCounts, b: UsageCounts): UsageCounts {
  return {
    input: a.input + b.input,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    webSearch: a.webSearch + b.webSearch,
    webFetch: a.webFetch + b.webFetch,
  };
}

/** Nombre total de tokens (toutes catégories de tokens, hors requêtes web). */
export function totalTokens(counts: UsageCounts): number {
  return counts.input + counts.cacheWrite5m + counts.cacheWrite1h + counts.cacheRead + counts.output;
}

/**
 * Calcule le coût en dollars d'un jeu de compteurs selon un tarif donné.
 * Les tarifs de tokens sont par MTok ; les requêtes web par millier de requêtes.
 */
export function costOf(counts: UsageCounts, pricing: ModelPricing): number {
  const perMillion =
    counts.input * pricing.input +
    counts.cacheWrite5m * pricing.cacheWrite5m +
    counts.cacheWrite1h * pricing.cacheWrite1h +
    counts.cacheRead * pricing.cacheRead +
    counts.output * pricing.output;

  const tokensCost = perMillion / 1_000_000;
  const webCost =
    (counts.webSearch * (pricing.webSearchPerThousand ?? 0) +
      counts.webFetch * (pricing.webFetchPerThousand ?? 0)) /
    1000;

  return tokensCost + webCost;
}
