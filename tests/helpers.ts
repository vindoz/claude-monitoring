import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantEvent, ClaudeUsage } from '../src/types/claude-events.js';

/** Crée un répertoire temporaire isolé pour un test. */
export function makeTempDir(prefix = 'ccmon-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Construit un event assistant minimal pour les fixtures. */
export function assistantEvent(params: {
  id: string;
  requestId?: string;
  model?: string;
  timestamp?: string;
  usage?: ClaudeUsage;
  cwd?: string;
  gitBranch?: string;
}): AssistantEvent {
  return {
    type: 'assistant',
    requestId: params.requestId,
    timestamp: params.timestamp,
    cwd: params.cwd,
    gitBranch: params.gitBranch,
    message: {
      id: params.id,
      model: params.model ?? 'claude-opus-4-8',
      usage: params.usage ?? { input_tokens: 100, output_tokens: 50 },
    },
  };
}

/** Sérialise une liste d'events en contenu JSONL (avec saut de ligne final). */
export function toJsonl(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** Écrit un fichier de transcript de session principale. */
export function writeSessionFile(
  projectsDir: string,
  projectSlug: string,
  sessionId: string,
  events: unknown[],
): string {
  const dir = join(projectsDir, projectSlug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, toJsonl(events));
  return path;
}

/** Écrit un fichier de transcript de sous-agent rattaché à une session. */
export function writeSubagentFile(
  projectsDir: string,
  projectSlug: string,
  sessionId: string,
  agentId: string,
  events: unknown[],
): string {
  const dir = join(projectsDir, projectSlug, sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(path, toJsonl(events));
  return path;
}

/**
 * Écrit le fichier de métadonnées jumeau d'un transcript de sous-agent
 * (`agent-<id>.meta.json`), tel que Claude Code le produit.
 */
export function writeSubagentMeta(
  projectsDir: string,
  projectSlug: string,
  sessionId: string,
  agentId: string,
  meta: Record<string, unknown>,
): string {
  const dir = join(projectsDir, projectSlug, sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `agent-${agentId}.meta.json`);
  writeFileSync(path, JSON.stringify(meta));
  return path;
}

/** Capture les écritures sur stdout/stderr pendant l'exécution d'une fonction. */
export function captureOutput(fn: () => void): { stdout: string; stderr: string } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error signature simplifiée pour le test
  process.stdout.write = (chunk: string) => {
    out.push(String(chunk));
    return true;
  };
  // @ts-expect-error signature simplifiée pour le test
  process.stderr.write = (chunk: string) => {
    err.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: out.join(''), stderr: err.join('') };
}
