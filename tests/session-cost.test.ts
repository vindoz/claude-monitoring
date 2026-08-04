import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeSessionCost, computeSessionUsage } from '../src/statusline/session-cost.js';
import { createResolver, loadPricingTable } from '../src/pricing/pricing-loader.js';
import { assistantEvent, makeTempDir, writeSessionFile, writeSubagentFile } from './helpers.js';

const resolver = createResolver(loadPricingTable());

describe('computeSessionCost', () => {
  it('inclut le coût des sous-agents (1M input opus main + 1M input opus subagent = 10 $)', () => {
    const projectsDir = makeTempDir();
    const mainPath = writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
    ]);
    writeSubagentFile(projectsDir, '-proj', 'sess1', 'a1', [
      assistantEvent({ id: 's1', requestId: 'rs', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
    ]);
    const r = computeSessionCost({ transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver });
    expect(r).toBeCloseTo(10, 3);
  });

  it('déduplique les lignes répétées du transcript principal', () => {
    const projectsDir = makeTempDir();
    const dup = assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } });
    const mainPath = writeSessionFile(projectsDir, '-proj', 'sess1', [dup, dup, dup]);
    const r = computeSessionCost({ transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver });
    expect(r).toBeCloseTo(5, 3); // 1M input opus une seule fois
  });

  it('applique le tarif par modèle (opus + fable-5)', () => {
    const projectsDir = makeTempDir();
    const mainPath = writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { output_tokens: 1_000_000 } }), // 25 $
      assistantEvent({ id: 'm2', requestId: 'r2', model: 'claude-fable-5', usage: { output_tokens: 1_000_000 } }), // 50 $ (2× Opus)
    ]);
    const r = computeSessionCost({ transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver });
    expect(r).toBeCloseTo(75, 3);
  });

  it('reconstruit le chemin depuis cwd + sessionId si transcript_path est absent', () => {
    const projectsDir = makeTempDir();
    // pathToSlug('/proj') === '-proj'
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
    ]);
    const r = computeSessionCost({ sessionId: 'sess1', cwd: '/proj', projectsDir, resolver });
    expect(r).toBeCloseTo(5, 3);
  });

  it('renvoie null quand la session est introuvable (repli sur le natif)', () => {
    const r = computeSessionCost({ transcriptPath: '/inexistant/x.jsonl', projectsDir: makeTempDir(), resolver });
    expect(r).toBeNull();
  });
});

describe('computeSessionUsage — sous-agents', () => {
  /** Session avec trois agents : deux sur Opus, un sur Haiku, plus un journal de workflow. */
  function sessionWithAgents() {
    const projectsDir = makeTempDir();
    const mainPath = writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
    ]);
    for (const [agent, model] of [
      ['a1', 'claude-opus-4-8'],
      ['a2', 'claude-opus-4-8'],
      ['a3', 'claude-haiku-4-5-20251001'],
    ] as const) {
      writeSubagentFile(projectsDir, '-proj', 'sess1', agent, [
        assistantEvent({ id: `s-${agent}`, requestId: `r-${agent}`, model, usage: { input_tokens: 1_000_000 } }),
      ]);
    }
    // Journal de workflow : sous `subagents/`, mais ce n'est pas un agent.
    const wfDir = join(projectsDir, '-proj', 'sess1', 'subagents', 'workflows', 'wf_1');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, 'journal.jsonl'), `${JSON.stringify({ type: 'started' })}\n`);

    return { projectsDir, mainPath };
  }

  it('compte les agents et leur modèle, sans compter le journal de workflow', () => {
    const { projectsDir, mainPath } = sessionWithAgents();
    const usage = computeSessionUsage({ transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver });
    expect(usage?.agentCount).toBe(3);
    expect(usage?.agentsByModel).toEqual([
      { model: 'claude-opus-4-8', count: 2 },
      { model: 'claude-haiku-4-5-20251001', count: 1 },
    ]);
  });

  it('donne le même coût avec et sans cache', () => {
    const { projectsDir, mainPath } = sessionWithAgents();
    const cachePath = join(makeTempDir(), 'cache.json');
    const params = { transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver };

    const sansCache = computeSessionUsage(params);
    const froid = computeSessionUsage({ ...params, cachePath });
    const chaud = computeSessionUsage({ ...params, cachePath });

    expect(froid?.cost).toBeCloseTo(sansCache!.cost, 6);
    expect(chaud?.cost).toBeCloseTo(sansCache!.cost, 6);
    expect(existsSync(cachePath)).toBe(true);
  });

  it('reprend en compte un transcript modifié après mise en cache', () => {
    const { projectsDir, mainPath } = sessionWithAgents();
    const cachePath = join(makeTempDir(), 'cache.json');
    const params = { transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver, cachePath };

    const avant = computeSessionUsage(params);
    appendFileSync(
      mainPath,
      `${JSON.stringify(assistantEvent({ id: 'm2', requestId: 'r2', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }))}\n`,
    );
    const après = computeSessionUsage(params);
    expect(après!.cost).toBeCloseTo(avant!.cost + 5, 3);
  });

  // Le statusline se rafraîchit pendant que Claude Code écrit : un message logique, réparti sur
  // plusieurs lignes qui répètent son `usage`, peut être coupé entre deux affichages. Sans
  // recollement, la seconde moitié serait comptée une deuxième fois.
  it('ne compte pas deux fois un message coupé entre deux lectures incrémentales', () => {
    const projectsDir = makeTempDir();
    const mainPath = writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
    ]);
    const cachePath = join(makeTempDir(), 'cache.json');
    const params = { transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver, cachePath };

    expect(computeSessionUsage(params)!.cost).toBeCloseTo(5, 3);

    // Première ligne du message m2, lue puis affichée…
    const m2 = assistantEvent({ id: 'm2', requestId: 'r2', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } });
    appendFileSync(mainPath, `${JSON.stringify(m2)}\n`);
    expect(computeSessionUsage(params)!.cost).toBeCloseTo(10, 3);

    // … puis sa seconde ligne, qui répète le même `usage` : elle ne doit rien ajouter.
    appendFileSync(mainPath, `${JSON.stringify(m2)}\n`);
    expect(computeSessionUsage(params)!.cost).toBeCloseTo(10, 3);
  });

  it('ignore une ligne encore incomplète et la reprend une fois terminée', () => {
    const projectsDir = makeTempDir();
    const mainPath = writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
    ]);
    const cachePath = join(makeTempDir(), 'cache.json');
    const params = { transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver, cachePath };
    computeSessionUsage(params);

    const m2 = JSON.stringify(
      assistantEvent({ id: 'm2', requestId: 'r2', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
    );
    appendFileSync(mainPath, m2.slice(0, 40)); // écriture en cours, pas de saut de ligne
    expect(computeSessionUsage(params)!.cost).toBeCloseTo(5, 3);

    appendFileSync(mainPath, `${m2.slice(40)}\n`); // la ligne se termine
    expect(computeSessionUsage(params)!.cost).toBeCloseTo(10, 3);
  });

  it('repart de zéro si le transcript est réécrit plus court', () => {
    const projectsDir = makeTempDir();
    const mainPath = writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
      assistantEvent({ id: 'm2', requestId: 'r2', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }),
    ]);
    const cachePath = join(makeTempDir(), 'cache.json');
    const params = { transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver, cachePath };
    expect(computeSessionUsage(params)!.cost).toBeCloseTo(10, 3);

    writeFileSync(
      mainPath,
      `${JSON.stringify(assistantEvent({ id: 'm3', requestId: 'r3', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000 } }))}\n`,
    );
    expect(computeSessionUsage(params)!.cost).toBeCloseTo(5, 3);
  });

  it('recalcule sans échouer quand le cache est corrompu', () => {
    const { projectsDir, mainPath } = sessionWithAgents();
    const cachePath = join(makeTempDir(), 'cache.json');
    writeFileSync(cachePath, 'ceci n’est pas du JSON');
    const usage = computeSessionUsage({ transcriptPath: mainPath, sessionId: 'sess1', cwd: '/x', projectsDir, resolver, cachePath });
    expect(usage?.cost).toBeCloseTo(16, 3); // 3 × 1M input opus (5 $) + 1M input haiku (1 $)
  });
});
