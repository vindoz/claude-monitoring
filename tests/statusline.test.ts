import { describe, expect, it } from 'vitest';
import { formatSkill, computeContext, formatAgents, formatStatusline } from '../src/commands/statusline.js';
import type { StatuslineInput } from '../src/types/claude-events.js';

describe('computeContext', () => {
  it('utilise used_percentage quand il est fourni', () => {
    const ctx = computeContext({
      context_window: { used_percentage: 42, total_input_tokens: 84000, context_window_size: 200000 },
    });
    expect(ctx.percent).toBe(42);
    expect(ctx.usedTokens).toBe(84000);
  });

  it('calcule le pourcentage depuis current_usage en repli', () => {
    const ctx = computeContext({
      context_window: {
        used_percentage: null,
        context_window_size: 200000,
        current_usage: { input_tokens: 10000, cache_read_input_tokens: 90000, cache_creation_input_tokens: 0, output_tokens: 5000 },
      },
    });
    expect(ctx.usedTokens).toBe(100000);
    expect(ctx.percent).toBeCloseTo(50, 5);
  });

  it('renvoie des valeurs nulles sans context_window', () => {
    expect(computeContext({})).toEqual({ percent: null, usedTokens: null, size: null });
  });
});

describe('formatStatusline', () => {
  const nominal: StatuslineInput = {
    model: { display_name: 'Fable 5' },
    cost: { total_cost_usd: 0.1234 },
    context_window: { used_percentage: 32, total_input_tokens: 136000, context_window_size: 1000000 },
  };

  it('formate une ligne nominale', () => {
    const line = formatStatusline(nominal, { noColor: true });
    expect(line).toContain('Fable 5');
    expect(line).toContain('$0.12');
    expect(line).toContain('32%');
  });

  it('affiche le coût complet override au lieu du chiffre natif', () => {
    const line = formatStatusline(nominal, { noColor: true }, {
      cost: 147.34,
      agentCount: 0,
      agentsByModel: [],
    });
    expect(line).toContain('$147.34');
    expect(line).not.toContain('$0.12');
  });

  it('affiche les sous-agents et leur modèle', () => {
    const line = formatStatusline(nominal, { noColor: true }, {
      cost: 10,
      agentCount: 3,
      agentsByModel: [
        { model: 'claude-opus-5', count: 2 },
        { model: 'claude-haiku-4-5-20251001', count: 1 },
      ],
    });
    expect(line).toContain('3 agents 2×opus-5 1×haiku-4-5-20251001');
  });

  it('n’allonge pas la ligne quand la session n’a aucun agent', () => {
    const line = formatStatusline(nominal, { noColor: true }, {
      cost: 10,
      agentCount: 0,
      agentsByModel: [],
    });
    expect(line).not.toContain('agent');
  });

  it('accorde le singulier', () => {
    expect(
      formatAgents({ cost: 0, agentCount: 1, agentsByModel: [{ model: 'claude-opus-5', count: 1 }] }),
    ).toBe('1 agent 1×opus-5');
  });

  it('tolère les champs nuls', () => {
    const line = formatStatusline(
      { model: { id: 'claude-fable-5' }, cost: { total_cost_usd: null }, context_window: { used_percentage: null, current_usage: null } },
      { noColor: true },
    );
    expect(line).toContain('claude-fable-5');
    expect(line).toContain('—');
  });

  it('formate en mode compact', () => {
    const line = formatStatusline({ cost: { total_cost_usd: 2.5 }, context_window: { used_percentage: 88 } }, {
      format: 'compact',
      noColor: true,
    });
    expect(line).toContain('$2.50');
    expect(line).toContain('88%');
  });

  it('gère une entrée totalement vide', () => {
    const line = formatStatusline({}, { noColor: true });
    expect(line).toContain('—');
  });
});

describe('formatSkill', () => {
  it('rend le skill courant et son coût', () => {
    expect(
      formatSkill({ cost: 9, agentCount: 0, agentsByModel: [], currentSkill: 'epct', currentSkillCost: 3.2 }),
    ).toBe('/epct $3.20');
  });

  it('ne rend rien hors skill', () => {
    expect(
      formatSkill({ cost: 9, agentCount: 0, agentsByModel: [], currentSkill: null, currentSkillCost: 0 }),
    ).toBe('');
    expect(formatSkill(null)).toBe('');
  });

  it('ne rend rien — et surtout pas « /undefined » — si le champ manque', () => {
    // Un appelant qui construit un `SessionUsage` partiel ne doit pas polluer la ligne.
    expect(formatSkill({ cost: 9, agentCount: 0, agentsByModel: [] } as never)).toBe('');
  });

  it('insère le segment dans la ligne complète, entre le contexte et les agents', () => {
    const line = formatStatusline(
      { model: { display_name: 'Opus' }, context_window: { used_percentage: 10 } },
      { noColor: true },
      { cost: 9, agentCount: 1, agentsByModel: [{ model: 'claude-opus-5', count: 1 }], currentSkill: 'epct', currentSkillCost: 3.2 },
    );
    const parts = line.split(' · ');
    expect(parts[3]).toBe('/epct $3.20');
    expect(parts[4]).toContain('agent');
  });
});
