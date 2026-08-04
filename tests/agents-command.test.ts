import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgents } from '../src/commands/agents.js';
import {
  assistantEvent,
  captureOutput,
  makeTempDir,
  writeSessionFile,
  writeSubagentFile,
  writeSubagentMeta,
} from './helpers.js';

/** Prépare deux sessions, chacune avec un agent sur un modèle différent. */
function setupProject() {
  const projectsDir = makeTempDir();
  const db = join(makeTempDir(), 'test.db');

  writeSessionFile(projectsDir, '-proj', 'sess1', [
    assistantEvent({
      id: 'm1',
      requestId: 'r1',
      model: 'claude-opus-4-8',
      timestamp: '2026-06-01T09:00:00Z',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    }),
  ]);
  writeSubagentFile(projectsDir, '-proj', 'sess1', 'aaa', [
    assistantEvent({
      id: 'a1',
      requestId: 'ra',
      model: 'claude-opus-4-8',
      timestamp: '2026-06-01T10:00:00Z',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    }),
  ]);
  writeSubagentMeta(projectsDir, '-proj', 'sess1', 'aaa', {
    agentType: 'plan-code',
    description: 'RELECTURE-PLAN démo',
  });

  writeSubagentFile(projectsDir, '-autre', 'sess2', 'bbb', [
    assistantEvent({
      id: 'b1',
      requestId: 'rb',
      model: 'claude-haiku-4-5-20251001',
      timestamp: '2026-06-02T10:00:00Z',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    }),
  ]);
  writeSubagentMeta(projectsDir, '-autre', 'sess2', 'bbb', {
    agentType: 'explore-code',
    description: 'Exploration démo',
  });

  return { projectsDir, db };
}

describe('runAgents', () => {
  it('produit un JSON listant les agents, leur modèle et leur coût', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() => runAgents({ db, projectsDir, json: true, quiet: true }));
    const parsed = JSON.parse(stdout);

    expect(parsed.agents).toHaveLength(2);
    const plan = parsed.agents.find((a: { agentId: string }) => a.agentId === 'aaa');
    expect(plan.title).toBe('RELECTURE-PLAN démo');
    expect(plan.models).toEqual(['claude-opus-4-8']);
    expect(plan.agentType).toBe('plan-code');
    expect(plan.costUsd).toBeCloseTo(5, 3); // 1M tokens input opus = 5 $
  });

  it('rend un tableau affichant le modèle derrière le titre', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() => runAgents({ db, projectsDir, quiet: true }));
    expect(stdout).toContain('RELECTURE-PLAN démo');
    expect(stdout).toContain('opus-4-8');
    expect(stdout).toContain('2 agents');
  });

  it('filtre par projet', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() =>
      runAgents({ db, projectsDir, project: '-autre', json: true, quiet: true }),
    );
    expect(JSON.parse(stdout).agents.map((a: { agentId: string }) => a.agentId)).toEqual(['bbb']);
  });

  it('filtre par session, y compris sur un préfixe', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() =>
      runAgents({ db, projectsDir, session: 'sess1', json: true, quiet: true }),
    );
    expect(JSON.parse(stdout).agents.map((a: { agentId: string }) => a.agentId)).toEqual(['aaa']);
  });

  it('filtre par période', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() =>
      runAgents({ db, projectsDir, since: '2026-06-02', json: true, quiet: true }),
    );
    expect(JSON.parse(stdout).agents.map((a: { agentId: string }) => a.agentId)).toEqual(['bbb']);
  });

  it('signale l’absence de résultat sans planter', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() =>
      runAgents({ db, projectsDir, session: 'inconnue', quiet: true }),
    );
    expect(stdout).toContain('Aucun sous-agent');
  });

  it('signale une base absente avec --no-ingest', () => {
    const { stderr } = captureOutput(() =>
      runAgents({ db: join(makeTempDir(), 'vide.db'), noIngest: true, quiet: true }),
    );
    expect(stderr).toContain('Aucune base');
  });
});
