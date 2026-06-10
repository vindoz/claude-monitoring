/** Familles de modèles connues. */
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable';

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
