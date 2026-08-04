import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { ingest } from '../src/db/ingest.js';
import { buildDashboardData } from '../src/commands/serve.js';
import { escapeHtml, renderDashboard } from '../src/web/render-html.js';
import { createResolver, loadPricingTable } from '../src/pricing/pricing-loader.js';
import {
  assistantEvent,
  makeTempDir,
  writeSessionFile,
  writeSubagentFile,
  writeSubagentMeta,
} from './helpers.js';

const resolver = createResolver(loadPricingTable());

describe('escapeHtml', () => {
  it('échappe les caractères spéciaux', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});

describe('dashboard', () => {
  function buildFromFixture() {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      { type: 'ai-title', aiTitle: 'Démo <script>alert(1)</script>', sessionId: 'sess1' },
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', timestamp: '2026-06-01T10:00:00Z', usage: { input_tokens: 1_000_000, output_tokens: 0 } }),
    ]);
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const data = buildDashboardData(db, resolver, {
      sessionsLimit: 30,
      generatedAt: '2026-06-10 13:00:00',
      granularity: 'day',
    });
    db.close();
    return data;
  }

  it('construit les sections du tableau de bord', () => {
    const data = buildFromFixture();
    expect(data.byProject.rows[0].key).toBe('-proj');
    expect(data.byModel.rows[0].key).toBe('claude-opus-4-8');
    expect(data.byDay.rows[0].key).toBe('2026-06-01');
    expect(data.sessions.rows).toHaveLength(1);
  });

  it('rend un HTML valide avec le coût total', () => {
    const html = renderDashboard(buildFromFixture());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Claude Monitoring');
    expect(html).toContain('$5.00'); // 1M tokens input opus
    expect(html).toContain('<table>');
  });

  it('affiche la grille tarifaire appliquée aux modèles rencontrés', () => {
    const data = buildFromFixture();
    expect(data.pricingRows).toEqual([
      expect.objectContaining({ model: 'claude-opus-4-8', match: 'exact' }),
    ]);
    const html = renderDashboard(data);
    expect(html).toContain('Grille tarifaire appliquée');
    expect(html).toContain('$25.00'); // output Opus 4.8
  });

  it('échappe le contenu utilisateur (anti-XSS)', () => {
    const html = renderDashboard(buildFromFixture());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('agents dans le tableau de bord', () => {
  /** Fixture : une session, sa boucle principale, et deux agents dont un enfant de l'autre. */
  function buildWithAgents(params: { since?: string; until?: string } = {}) {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({
        id: 'main1',
        requestId: 'r0',
        model: 'claude-opus-4-8',
        timestamp: '2026-06-01T09:00:00Z',
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      }),
    ]);
    writeSubagentFile(projectsDir, '-proj', 'sess1', 'parent', [
      assistantEvent({
        id: 'p1',
        requestId: 'r1',
        model: 'claude-opus-4-8',
        timestamp: '2026-06-01T10:00:00Z',
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      }),
    ]);
    writeSubagentMeta(projectsDir, '-proj', 'sess1', 'parent', {
      agentType: 'plan-code',
      description: 'RELECTURE-PLAN v10 — lentille Stripe',
      spawnDepth: 1,
    });
    writeSubagentFile(projectsDir, '-proj', 'sess1', 'enfant', [
      assistantEvent({
        id: 'e1',
        requestId: 'r2',
        model: 'claude-haiku-4-5-20251001',
        timestamp: '2026-06-05T10:00:00Z',
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      }),
    ]);
    writeSubagentMeta(projectsDir, '-proj', 'sess1', 'enfant', {
      agentType: 'explore-code',
      description: 'Exploration déléguée',
      parentAgentId: 'parent',
      spawnDepth: 2,
    });

    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const data = buildDashboardData(db, resolver, {
      sessionsLimit: 30,
      generatedAt: '2026-06-10 13:00:00',
      granularity: 'day',
      since: params.since,
      until: params.until,
    });
    db.close();
    return data;
  }

  it('rattache les agents à leur session', () => {
    const agents = buildWithAgents().agentsBySession.get('sess1');
    expect(agents?.map((a) => a.title).sort()).toEqual([
      'Exploration déléguée',
      'RELECTURE-PLAN v10 — lentille Stripe',
    ]);
  });

  it('affiche le titre de l’agent suivi de son modèle', () => {
    const html = renderDashboard(buildWithAgents());
    expect(html).toContain('RELECTURE-PLAN v10 — lentille Stripe');
    expect(html).toContain('<td class="model">opus-4-8</td>');
    expect(html).toContain('<td class="model">haiku-4-5-20251001</td>');
  });

  it('déplie les agents sans JavaScript', () => {
    const html = renderDashboard(buildWithAgents());
    expect(html).toContain('<input type="checkbox" id="ag-sess1" />');
    expect(html).toContain('tr.sess:has(input:checked) + tr.kids');
    expect(html).not.toContain('<script');
  });

  it('indente l’agent enfant sous son parent', () => {
    const html = renderDashboard(buildWithAgents());
    const parent = html.indexOf('RELECTURE-PLAN v10');
    const enfant = html.indexOf('Exploration déléguée');
    expect(parent).toBeGreaterThan(-1);
    expect(enfant).toBeGreaterThan(parent); // l'enfant suit immédiatement son parent
    expect(html).toContain('padding-left:26px'); // 8 + 1 × 18
  });

  it('n’affiche pas de chevron pour une session sans agent', () => {
    const projectsDir = makeTempDir();
    writeSessionFile(projectsDir, '-proj', 'seule', [
      assistantEvent({ id: 'm', requestId: 'r', timestamp: '2026-06-01T09:00:00Z' }),
    ]);
    const db = openDatabase(':memory:');
    ingest(db, projectsDir);
    const html = renderDashboard(
      buildDashboardData(db, resolver, {
        sessionsLimit: 30,
        generatedAt: '2026-06-10 13:00:00',
        granularity: 'day',
      }),
    );
    db.close();
    expect(html).toContain('<td class="toggle"></td>');
    expect(html).not.toContain('<input type="checkbox"');
  });

  it('écarte les agents hors de la période sélectionnée', () => {
    const data = buildWithAgents({ since: '2026-06-01', until: '2026-06-01' });
    const agents = data.agentsBySession.get('sess1');
    expect(agents?.map((a) => a.title)).toEqual(['RELECTURE-PLAN v10 — lentille Stripe']);
  });

  it('nomme le solde « reste », jamais « boucle principale » seule', () => {
    const html = renderDashboard(buildWithAgents());
    expect(html).toContain('reste (boucle principale + agents non reconstructibles)');
  });
});
