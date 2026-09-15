import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSkills } from '../src/commands/skills.js';
import { runTools } from '../src/commands/tools.js';
import {
  assistantEvent,
  captureOutput,
  makeTempDir,
  toolResultEvent,
  toolUseLine,
  writeSessionFile,
} from './helpers.js';

/**
 * Prépare une session représentative : une chaîne `epct-sexy → epct`, un appel MCP, un appel
 * natif en erreur, et un message hors skill.
 */
function setupProject() {
  const projectsDir = makeTempDir();
  const db = join(makeTempDir(), 'test.db');

  writeSessionFile(projectsDir, '-proj', 'sess1', [
    assistantEvent({
      id: 'm0',
      requestId: 'r0',
      timestamp: '2026-06-01T09:00:00Z',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    }),
    assistantEvent({
      id: 'm1',
      requestId: 'r1',
      timestamp: '2026-06-01T09:01:00Z',
      attributionSkill: 'epct-sexy',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    }),
    toolUseLine({
      id: 'm1',
      requestId: 'r1',
      timestamp: '2026-06-01T09:01:00Z',
      attributionSkill: 'epct-sexy',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      toolUseId: 'toolu_skill',
      toolName: 'Skill',
      input: { skill: 'epct' },
    }),
    assistantEvent({
      id: 'm2',
      requestId: 'r2',
      timestamp: '2026-06-01T09:02:00Z',
      attributionSkill: 'epct',
      usage: { input_tokens: 2_000_000, output_tokens: 0 },
    }),
    toolUseLine({
      id: 'm2',
      requestId: 'r2',
      timestamp: '2026-06-01T09:02:00Z',
      attributionSkill: 'epct',
      usage: { input_tokens: 2_000_000, output_tokens: 0 },
      toolUseId: 'toolu_jira',
      toolName: 'mcp__jira__jira_get_issue',
    }),
    toolResultEvent({ toolUseId: 'toolu_jira', content: 'j'.repeat(2000), timestamp: '2026-06-01T09:02:01Z' }),
    toolUseLine({
      id: 'm3',
      requestId: 'r3',
      timestamp: '2026-06-01T09:03:00Z',
      attributionSkill: 'epct',
      toolUseId: 'toolu_bash',
      toolName: 'Bash',
    }),
    toolResultEvent({ toolUseId: 'toolu_bash', content: 'boom', isError: true, timestamp: '2026-06-01T09:03:01Z' }),
  ]);

  return { projectsDir, db };
}

describe('ccmon skills', () => {
  it('rend le coût par skill et le pipeline de chacun, en JSON', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() => runSkills({ projectsDir, db, json: true, quiet: true }));
    const parsed = JSON.parse(stdout) as {
      skills: Array<{ skill: string; pipeline: string; costUsd: number }>;
      pipelines: Array<{ pipeline: string }>;
      total: { costUsd: number };
    };

    const epct = parsed.skills.find((s) => s.skill === 'epct');
    expect(epct?.pipeline).toBe('epct-sexy');
    expect(epct?.costUsd).toBeGreaterThan(0);
    expect(parsed.skills.map((s) => s.skill)).toContain('(hors skill)');
    expect(parsed.pipelines.map((p) => p.pipeline).sort()).toEqual(['(hors skill)', 'epct-sexy']);
  });

  it('filtre par pipeline', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() =>
      runSkills({ projectsDir, db, json: true, quiet: true, pipeline: 'epct-sexy' }),
    );
    const parsed = JSON.parse(stdout) as { skills: Array<{ skill: string }> };
    expect(parsed.skills.map((s) => s.skill).sort()).toEqual(['epct', 'epct-sexy']);
  });

  it('rend un tableau lisible avec les colonnes Skill et Pipeline', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() => runSkills({ projectsDir, db, quiet: true }));
    expect(stdout).toContain('Skill');
    expect(stdout).toContain('Pipeline');
    expect(stdout).toContain('epct-sexy');
    expect(stdout).toContain('Par pipeline');
  });

  it('respecte le filtre de période', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() =>
      runSkills({ projectsDir, db, json: true, quiet: true, since: '2027-01-01' }),
    );
    expect((JSON.parse(stdout) as { skills: unknown[] }).skills).toEqual([]);
  });
});

describe('ccmon tools', () => {
  it('rend les appels, les erreurs et le contexte injecté, sans aucun coût', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() => runTools({ projectsDir, db, json: true, quiet: true }));
    const parsed = JSON.parse(stdout) as {
      tools: Array<{ tool: string; server: string; skill: string; callCount: number; errorCount: number; estimatedTokens: number }>;
      servers: Array<{ server: string }>;
      total: { callCount: number; errorCount: number };
    };

    const jira = parsed.tools.find((t) => t.tool === 'mcp__jira__jira_get_issue');
    expect(jira).toMatchObject({ server: 'mcp:jira', skill: 'epct', callCount: 1, errorCount: 0 });
    expect(jira?.estimatedTokens).toBe(500); // 2000 caractères
    expect(parsed.tools.find((t) => t.tool === 'Bash')?.errorCount).toBe(1);
    expect(parsed.total.callCount).toBe(3);
    expect(JSON.stringify(parsed)).not.toContain('costUsd');
  });

  it('ne garde que les outils MCP avec --mcp', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() => runTools({ projectsDir, db, json: true, quiet: true, mcp: true }));
    const parsed = JSON.parse(stdout) as { tools: Array<{ server: string }> };
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].server).toBe('mcp:jira');
  });

  it('accepte un serveur donné avec ou sans le préfixe `mcp:`', () => {
    const { projectsDir, db } = setupProject();
    const brut = captureOutput(() => runTools({ projectsDir, db, json: true, quiet: true, server: 'jira' })).stdout;
    const prefixe = captureOutput(() => runTools({ projectsDir, db, json: true, quiet: true, server: 'mcp:jira' })).stdout;
    expect(brut).toBe(prefixe);
    expect((JSON.parse(brut) as { tools: unknown[] }).tools).toHaveLength(1);
  });

  it('filtre par skill', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() => runTools({ projectsDir, db, json: true, quiet: true, skill: 'epct' }));
    const parsed = JSON.parse(stdout) as { tools: Array<{ skill: string }> };
    expect(parsed.tools.every((t) => t.skill === 'epct')).toBe(true);
    expect(parsed.tools.length).toBeGreaterThan(0);
  });

  it('signale l’absence de résultat plutôt que d’afficher un tableau vide', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() =>
      runTools({ projectsDir, db, quiet: true, server: 'inexistant' }),
    );
    expect(stdout).toContain('Aucun appel');
  });
});
