import { describe, expect, it } from 'vitest';
import { computeSessionCost } from '../src/statusline/session-cost.js';
import { createResolver, loadPricingTable } from '../src/pricing/pricing-loader.js';
import { assistantEvent, makeTempDir, writeSessionFile, writeSubagentFile } from './helpers.js';

const resolver = createResolver(loadPricingTable());

describe('computeSessionCost', () => {
  it('inclut le coût des sous-agents (1M input opus main + 1M input opus subagent = 30 $)', () => {
    const projectsDir = makeTempDir();
    const mainPath = writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
    ]);
    writeSubagentFile(projectsDir, '-proj', 'sess1', 'a1', [
      assistantEvent({ id: 's1', requestId: 'rs', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
    ]);
    const r = computeSessionCost({ transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver });
    expect(r).toBeCloseTo(30, 3);
  });

  it('déduplique les lignes répétées du transcript principal', () => {
    const projectsDir = makeTempDir();
    const dup = assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } });
    const mainPath = writeSessionFile(projectsDir, '-proj', 'sess1', [dup, dup, dup]);
    const r = computeSessionCost({ transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver });
    expect(r).toBeCloseTo(15, 3); // 1M input opus une seule fois
  });

  it('applique le tarif par modèle (opus + fable-5)', () => {
    const projectsDir = makeTempDir();
    const mainPath = writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { output_tokens: 1_000_000 } }), // 75 $
      assistantEvent({ id: 'm2', requestId: 'r2', model: 'claude-fable-5', usage: { output_tokens: 1_000_000 } }), // 150 $ (2× Opus)
    ]);
    const r = computeSessionCost({ transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver });
    expect(r).toBeCloseTo(225, 3);
  });

  it('reconstruit le chemin depuis cwd + sessionId si transcript_path est absent', () => {
    const projectsDir = makeTempDir();
    // pathToSlug('/proj') === '-proj'
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
    ]);
    const r = computeSessionCost({ sessionId: 'sess1', cwd: '/proj', projectsDir, resolver });
    expect(r).toBeCloseTo(15, 3);
  });

  it('renvoie null quand la session est introuvable (repli sur le natif)', () => {
    const r = computeSessionCost({ transcriptPath: '/inexistant/x.jsonl', projectsDir: makeTempDir(), resolver });
    expect(r).toBeNull();
  });
});
