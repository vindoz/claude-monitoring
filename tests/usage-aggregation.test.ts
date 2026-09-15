import { describe, expect, it } from 'vitest';
import { skillInvocationFrom, extractToolResults,
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

describe('extractToolResults', () => {
  /** Construit un event `user` porteur d'un résultat d'outil. */
  function result(content: unknown, isError = false) {
    return {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content, is_error: isError }] },
    };
  }

  it('mesure un contenu livré sous forme de chaîne', () => {
    expect(extractToolResults(result('abcdef'))).toEqual([
      { toolUseId: 't1', chars: 6, images: 0, isError: false },
    ]);
  });

  it('somme les blocs de texte d’un contenu en liste', () => {
    const out = extractToolResults(result([{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }]));
    expect(out[0].chars).toBe(5);
  });

  it('exclut les images du poids de texte et les compte à part', () => {
    const out = extractToolResults(
      result([{ type: 'image', source: { data: 'A'.repeat(1000) } }, { type: 'text', text: 'ok' }]),
    );
    expect(out[0]).toMatchObject({ chars: 2, images: 1 });
  });

  it('retient une forme inconnue via sa sérialisation plutôt que de la compter pour rien', () => {
    const out = extractToolResults(result([{ type: 'tool_reference', name: 'x' }]));
    expect(out[0].chars).toBeGreaterThan(0);
    expect(out[0].images).toBe(0);
  });

  it('remonte l’état d’erreur', () => {
    expect(extractToolResults(result('boom', true))[0].isError).toBe(true);
  });

  it('ignore un event qui n’est pas un `user`, ou sans identifiant d’appel', () => {
    expect(extractToolResults({ type: 'assistant' })).toEqual([]);
    expect(
      extractToolResults({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
    ).toEqual([]);
    expect(extractToolResults({ type: 'user', message: { content: 'texte libre' } })).toEqual([]);
  });
});

describe('skillInvocationFrom', () => {
  /** Construit une ligne assistant portant un `tool_use` `Skill`. */
  function invocation(parent: string | undefined, child: unknown) {
    return {
      type: 'assistant' as const,
      attributionSkill: parent,
      message: {
        id: 'm',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 't', name: 'Skill', input: { skill: child } }],
      },
    };
  }

  it('relève l’arête quand l’appelant est lui-même sous un skill', () => {
    expect(skillInvocationFrom(invocation('epct-sexy', 'epct'))).toEqual({
      parent: 'epct-sexy',
      child: 'epct',
    });
  });

  it('n’en relève aucune depuis la boucle principale', () => {
    expect(skillInvocationFrom(invocation(undefined, 'voice'))).toBeNull();
  });

  it('n’en relève aucune pour un skill qui se réinvoque', () => {
    expect(skillInvocationFrom(invocation('voice', 'voice'))).toBeNull();
  });

  it('tolère une entrée sans nom de skill exploitable', () => {
    expect(skillInvocationFrom(invocation('epct', undefined))).toBeNull();
    expect(skillInvocationFrom(invocation('epct', '  '))).toBeNull();
    expect(skillInvocationFrom(invocation('epct', 42))).toBeNull();
  });
});
