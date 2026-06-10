import { describe, expect, it } from 'vitest';
import {
  aggregateUsageByModel,
  extractAssistantUsage,
} from '../src/report/usage-aggregation.js';
import { assistantEvent } from './helpers.js';

describe('extractAssistantUsage', () => {
  it('extrait un message assistant facturable', () => {
    const u = extractAssistantUsage(
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 100 } }),
    );
    expect(u).toMatchObject({ ok: true, model: 'claude-opus-4-8', messageId: 'm1' });
    expect(u.ok && u.counts.input).toBe(100);
  });

  it('porte la raison du rejet', () => {
    expect(extractAssistantUsage({ type: 'ai-title', aiTitle: 'x' })).toEqual({ ok: false, reason: 'not-assistant' });
    expect(
      extractAssistantUsage({ type: 'assistant', requestId: 'r', message: { id: 'm', model: '<synthetic>' } }),
    ).toEqual({ ok: false, reason: 'synthetic' });
    expect(extractAssistantUsage({ type: 'assistant', message: { model: 'claude-opus-4-8' } })).toEqual({
      ok: false,
      reason: 'no-id',
    });
    expect(extractAssistantUsage({ type: 'assistant', message: { id: 'm' } })).toEqual({
      ok: false,
      reason: 'no-model',
    });
  });
});

describe('aggregateUsageByModel', () => {
  it('agrège par modèle et déduplique (message.id, requestId)', () => {
    const m1 = assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 100 } });
    const events = [
      m1,
      m1, // doublon
      assistantEvent({ id: 'm2', requestId: 'r2', model: 'claude-opus-4-8', usage: { input_tokens: 50 } }),
      assistantEvent({ id: 'h1', requestId: 'r3', model: 'claude-haiku-4-5', usage: { input_tokens: 200 } }),
    ];
    const agg = aggregateUsageByModel(events);
    expect(agg.messagesCounted).toBe(3);
    expect(agg.duplicates).toBe(1);
    expect(agg.byModel.get('claude-opus-4-8')?.input).toBe(150);
    expect(agg.byModel.get('claude-haiku-4-5')?.input).toBe(200);
  });
});
