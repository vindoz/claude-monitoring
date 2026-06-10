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

/** Fuseau horaire d'affichage : équipe et clients francophones (gère l'heure d'été). */
const DISPLAY_TIMEZONE = 'Europe/Paris';

/**
 * Formate une date en `YYYY-MM-DD HH:MM:SS` dans le fuseau d'affichage (Europe/Paris).
 * La locale `sv-SE` produit nativement ce format ISO en 24 h.
 */
export function formatLocalDateTime(date: Date): string {
  return date.toLocaleString('sv-SE', {
    timeZone: DISPLAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Formate un horodatage (ms) en date/heure locale courte (`YYYY-MM-DD HH:MM`, fuseau Europe/Paris),
 * ou `'—'` si absent.
 */
export function formatDateTime(ms: number | null | undefined): string {
  if (ms == null) {
    return '—';
  }
  return formatLocalDateTime(new Date(ms)).slice(0, 16);
}
