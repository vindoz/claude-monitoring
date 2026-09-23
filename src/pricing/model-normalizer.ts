/** Familles de modèles connues. */
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable';

/**
 * Suffixe de la clé de facturation d'un message servi en fast mode. Le transcript garde
 * l'identifiant du modèle et signale la vitesse dans `usage.speed` : le suffixe reporte cette
 * information dans la clé, seul axe par lequel les agrégats distinguent deux tarifs.
 */
export const FAST_MODE_SUFFIX = '@fast';

/**
 * Clé de modèle de facturation : l'identifiant, suffixé de `@fast` si le message a été servi
 * en fast mode. Ex. `claude-opus-5-5` + `fast` → `claude-opus-5-5@fast`.
 */
export function billingModelId(model: string, speed: string | undefined): string {
  return speed === 'fast' ? `${model}${FAST_MODE_SUFFIX}` : model;
}

/** Sépare une clé de facturation en identifiant de base et indicateur de fast mode. */
export function splitFastMode(model: string): { base: string; fast: boolean } {
  return model.endsWith(FAST_MODE_SUFFIX)
    ? { base: model.slice(0, -FAST_MODE_SUFFIX.length), fast: true }
    : { base: model, fast: false };
}

/**
 * Retire un éventuel suffixe de date `-YYYYMMDD` d'un identifiant de modèle.
 * Ex. `claude-haiku-4-5-20251001` → `claude-haiku-4-5`.
 */
export function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

/**
 * Détermine la famille d'un modèle à partir de son identifiant (même nu, ex. `opus`).
 * @returns la famille, ou `null` si non reconnue.
 */
export function modelFamily(model: string): ModelFamily | null {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) {
    return 'opus';
  }
  if (lower.includes('sonnet')) {
    return 'sonnet';
  }
  if (lower.includes('haiku')) {
    return 'haiku';
  }
  if (lower.includes('fable')) {
    return 'fable';
  }
  return null;
}

/** Indique si un modèle correspond à un event synthétique (gratuit, à exclure de la facturation). */
export function isSyntheticModel(model: string): boolean {
  return model.toLowerCase().includes('synthetic');
}
