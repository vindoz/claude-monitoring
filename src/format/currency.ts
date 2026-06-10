/**
 * Formatage des montants, des tokens et des dates pour l'affichage terminal.
 */

/** Formate un montant en dollars, avec plus de décimales pour les très petits montants. */
export function formatUsd(amount: number): string {
  if (amount === 0) {
    return '$0.00';
  }
  if (Math.abs(amount) < 0.01) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(2)}`;
}

/** Formate un nombre de tokens de façon compacte (k / M). */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(2)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
}

/** Formate un pourcentage. */
export function formatPercent(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`;
}

/** Formate un horodatage (ms) en date/heure locale courte, ou `'—'` si absent. */
export function formatDateTime(ms: number | null | undefined): string {
  if (ms == null) {
    return '—';
  }
  const d = new Date(ms);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return `${date} ${time}`;
}
