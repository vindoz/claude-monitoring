import { isAssistantEvent, type ClaudeEvent } from '../types/claude-events.js';
import { isSyntheticModel } from '../pricing/model-normalizer.js';
import { addUsage, usageFromClaude, zeroUsage, type UsageCounts } from '../pricing/cost-model.js';

/**
 * Règle métier PARTAGÉE de comptabilisation d'un message assistant.
 * Centralise ici (réutilisée par l'ingestion DB et par le calcul de coût du statusline)
 * la décision « ce message est-il facturable ? » et l'extraction de ses compteurs, afin que
 * les deux chemins ne divergent jamais. La RAISON du rejet est portée par le helper (et non
 * redéduite par l'appelant) pour rester exacte si une cause de rejet est ajoutée.
 */
export type UsageExtraction =
  | { ok: true; model: string; messageId: string; requestId: string; counts: UsageCounts }
  | { ok: false; reason: 'not-assistant' | 'no-model' | 'synthetic' | 'no-id' };

/** Extrait l'usage facturable d'un event, ou la raison pour laquelle il n'est pas comptable. */
export function extractAssistantUsage(event: ClaudeEvent): UsageExtraction {
  if (!isAssistantEvent(event)) {
    return { ok: false, reason: 'not-assistant' };
  }
  const model = event.message?.model;
  if (!model) {
    return { ok: false, reason: 'no-model' };
  }
  if (isSyntheticModel(model)) {
    return { ok: false, reason: 'synthetic' };
  }
  const messageId = event.message?.id;
  if (!messageId) {
    return { ok: false, reason: 'no-id' };
  }
  return {
    ok: true,
    model,
    messageId,
    requestId: event.requestId ?? '',
    counts: usageFromClaude(event.message?.usage),
  };
}

/** Résultat d'agrégation en mémoire. */
export interface AggregatedUsage {
  /** Compteurs agrégés par modèle (le coût se calcule par modèle car les tarifs diffèrent). */
  byModel: Map<string, UsageCounts>;
  messagesCounted: number;
  duplicates: number;
}

/**
 * Agrège l'usage d'une liste d'events par modèle, en déduisant les doublons
 * `(message.id, requestId)` (un message logique est réparti sur plusieurs lignes répétant
 * le `usage`, et l'historique est rejoué — sans dédup le coût serait fortement sur-compté).
 */
export function aggregateUsageByModel(events: Iterable<ClaudeEvent>): AggregatedUsage {
  const byModel = new Map<string, UsageCounts>();
  const seen = new Set<string>();
  let messagesCounted = 0;
  let duplicates = 0;

  for (const event of events) {
    const extracted = extractAssistantUsage(event);
    if (!extracted.ok) {
      continue;
    }
    const key = `${extracted.messageId}|${extracted.requestId}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    byModel.set(extracted.model, addUsage(byModel.get(extracted.model) ?? zeroUsage(), extracted.counts));
    messagesCounted += 1;
  }

  return { byModel, messagesCounted, duplicates };
}
