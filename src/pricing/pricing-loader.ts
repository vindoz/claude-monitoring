import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { userPricingPath } from '../config/paths.js';
import {
  DEFAULT_PRICING,
  FAMILY_PRICING,
  FREE_PRICING,
  fastModePricing,
  type ModelPricing,
} from './default-pricing.js';
import {
  FAST_MODE_SUFFIX,
  isSyntheticModel,
  modelFamily,
  normalizeModelId,
  splitFastMode,
} from './model-normalizer.js';

/** Schéma de validation d'une entrée de pricing fournie par l'utilisateur. */
const modelPricingSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheWrite5m: z.number().nonnegative(),
  cacheWrite1h: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  webSearchPerThousand: z.number().nonnegative().optional(),
  webFetchPerThousand: z.number().nonnegative().optional(),
});

/** Un fichier d'override est un dictionnaire { identifiant de modèle → tarif }. */
const overrideSchema = z.record(modelPricingSchema);

/** Nature de la correspondance trouvée pour un modèle donné. */
export type PricingMatch = 'exact' | 'family' | 'synthetic' | 'unknown';

/** Résultat de la résolution du tarif d'un modèle. */
export interface ResolvedPricing {
  /** Tarif applicable (tarif gratuit pour `synthetic`/`unknown`). */
  pricing: ModelPricing;
  /** Type de correspondance (sert à signaler les modèles non tarifés). */
  match: PricingMatch;
  /** Identifiant canonique (suffixe de date retiré). */
  canonical: string;
}

/** Résolveur de tarif pré-construit autour d'une table fusionnée. */
export interface PricingResolver {
  resolve(model: string): ResolvedPricing;
}

/**
 * Charge et valide un fichier d'override de pricing utilisateur.
 * @throws si le fichier existe mais est invalide (JSON ou schéma).
 */
export function loadOverrideFile(path: string): Record<string, ModelPricing> {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return overrideSchema.parse(parsed);
}

/**
 * Construit la table de pricing effective : grille par défaut surchargée par l'override.
 * @param overridePath chemin d'un override optionnel ; ignoré s'il n'existe pas.
 */
export function loadPricingTable(overridePath?: string): Record<string, ModelPricing> {
  const override = overridePath ? loadOverrideFile(overridePath) : {};
  return { ...DEFAULT_PRICING, ...override };
}

/**
 * Construit le résolveur de tarif (grille par défaut + override utilisateur éventuel).
 * Sans dépendance à la base de données : utilisable sur le hot path du statusline.
 */
export function buildResolver(pricingPath?: string): PricingResolver {
  return createResolver(loadPricingTable(pricingPath ?? userPricingPath()));
}

/**
 * Crée un résolveur de tarif à partir d'une table fusionnée.
 * Ordre de résolution : synthétique → correspondance exacte (id canonique puis brut)
 * → repli par famille → inconnu (tarif gratuit, signalé).
 *
 * Une clé suffixée `@fast` prend d'abord une surcharge explicite (`claude-opus-5-5@fast`) ; à
 * défaut, elle reçoit le tarif de son modèle de base au multiplicateur du fast mode, avec la
 * même nature de correspondance — un modèle de base inconnu reste signalé comme tel.
 */
export function createResolver(table: Record<string, ModelPricing>): PricingResolver {
  const resolveStandard = (model: string): ResolvedPricing => {
    if (isSyntheticModel(model)) {
      return { pricing: FREE_PRICING, match: 'synthetic', canonical: model };
    }
    const canonical = normalizeModelId(model);

    const exact = table[canonical] ?? table[model];
    if (exact) {
      return { pricing: exact, match: 'exact', canonical };
    }

    const family = modelFamily(canonical);
    if (family) {
      const familyPricing = table[family] ?? FAMILY_PRICING[family];
      return { pricing: familyPricing, match: 'family', canonical };
    }

    return { pricing: FREE_PRICING, match: 'unknown', canonical };
  };

  return {
    resolve(model: string): ResolvedPricing {
      const { base, fast } = splitFastMode(model);
      if (!fast) {
        return resolveStandard(model);
      }
      // Clé normalisée d'abord : un id daté `…-20260101@fast` doit trouver `…@fast`.
      const canonical = `${normalizeModelId(base)}${FAST_MODE_SUFFIX}`;
      const override = table[canonical] ?? table[model];
      if (override) {
        return { pricing: override, match: 'exact', canonical };
      }
      const standard = resolveStandard(base);
      return { pricing: fastModePricing(standard.pricing), match: standard.match, canonical };
    },
  };
}
