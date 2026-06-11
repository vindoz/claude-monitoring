import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { ingest } from '../src/db/ingest.js';
import { buildDashboardData } from '../src/commands/serve.js';
import { escapeHtml, renderDashboard } from '../src/web/render-html.js';
import { createResolver, loadPricingTable } from '../src/pricing/pricing-loader.js';
import { assistantEvent, makeTempDir, writeSessionFile } from './helpers.js';

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
