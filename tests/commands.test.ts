import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runIngest } from '../src/commands/ingest.js';
import { runSessions } from '../src/commands/sessions.js';
import { runSummary } from '../src/commands/summary.js';
import { runStatusline } from '../src/commands/statusline.js';
import { assistantEvent, captureOutput, makeTempDir, writeSessionFile } from './helpers.js';

/** Prépare un répertoire de projets de test et renvoie les chemins utiles. */
function setupProject() {
  const projectsDir = makeTempDir();
  const db = join(makeTempDir(), 'test.db');
  writeSessionFile(projectsDir, '-proj', 'sess1', [
    { type: 'ai-title', aiTitle: 'Session de test', sessionId: 'sess1' },
    assistantEvent({ id: 'm1', requestId: 'r1', model: 'claude-opus-4-8', timestamp: '2026-06-01T10:00:00Z', usage: { input_tokens: 1_000_000, output_tokens: 0 } }),
  ]);
  return { projectsDir, db };
}

afterEach(() => {
  process.exitCode = 0;
});

describe('runIngest', () => {
  it('affiche un bilan sur stdout', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() => runIngest({ db, projectsDir }));
    expect(stdout).toContain('Fichiers scannés');
    expect(stdout).toContain('Messages comptés');
  });
});

describe('runSessions', () => {
  it('produit un JSON listant les sessions et leur coût', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() => runSessions({ db, projectsDir, json: true, quiet: true }));
    const parsed = JSON.parse(stdout);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].title).toBe('Session de test');
    expect(parsed.sessions[0].costUsd).toBeCloseTo(5, 3); // 1M input opus = 5 $
  });

  it('signale une base absente avec --no-ingest', () => {
    const { stderr } = captureOutput(() =>
      runSessions({ db: join(makeTempDir(), 'vide.db'), noIngest: true, quiet: true }),
    );
    expect(stderr).toContain('Aucune base');
  });
});

describe('runSummary', () => {
  it('agrège par modèle au format JSON', () => {
    const { projectsDir, db } = setupProject();
    const { stdout } = captureOutput(() => runSummary({ by: 'model', db, projectsDir, json: true, quiet: true }));
    const parsed = JSON.parse(stdout);
    expect(parsed.by).toBe('model');
    expect(parsed.rows[0].key).toBe('claude-opus-4-8');
  });

  it('rejette une dimension invalide (code de sortie 2)', () => {
    captureOutput(() => runSummary({ by: 'foo' as never, db: join(makeTempDir(), 'x.db'), quiet: true }));
    expect(process.exitCode).toBe(2);
  });

  it('signale un modèle non tarifé (code de sortie 3)', () => {
    const projectsDir = makeTempDir();
    const db = join(makeTempDir(), 'test.db');
    writeSessionFile(projectsDir, '-proj', 'sess1', [
      assistantEvent({ id: 'm1', requestId: 'r1', model: 'mystery-model', timestamp: '2026-06-01T10:00:00Z', usage: { input_tokens: 1000, output_tokens: 0 } }),
    ]);
    captureOutput(() => runSummary({ by: 'model', db, projectsDir, quiet: true }));
    expect(process.exitCode).toBe(3);
  });
});

describe('runStatusline', () => {
  it('lit le JSON sur stdin et écrit une ligne', async () => {
    const fake = Readable.from(['{"cost":{"total_cost_usd":1.5},"context_window":{"used_percentage":20}}']);
    Object.defineProperty(fake, 'isTTY', { value: false });
    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true });

    const out: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // @ts-expect-error signature simplifiée pour le test
    process.stdout.write = (chunk: string) => {
      out.push(String(chunk));
      return true;
    };
    try {
      await runStatusline({ noColor: true });
    } finally {
      process.stdout.write = origWrite;
      if (original) {
        Object.defineProperty(process, 'stdin', original);
      }
    }
    expect(out.join('')).toContain('$1.50');
    expect(out.join('')).toContain('20%');
  });
});
