import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentIdFromPath,
  agentMetaPathFor,
  agentTitle,
  parseSessionPath,
  pathToSlug,
  prettyProject,
  readAgentMeta,
} from '../src/parser/session-path.js';
import { makeTempDir } from './helpers.js';

const ROOT = '/home/user/.claude/projects';

describe('parseSessionPath', () => {
  it('reconnaît une session principale', () => {
    const info = parseSessionPath(join(ROOT, '-home-user-projets-demo', 'abc.jsonl'), ROOT);
    expect(info).toEqual({
      projectSlug: '-home-user-projets-demo',
      sessionId: 'abc',
      isSubagent: false,
      agentId: null,
    });
  });

  it('reconnaît un transcript de sous-agent', () => {
    const info = parseSessionPath(
      join(ROOT, '-slug', 'sess-1', 'subagents', 'agent-x.jsonl'),
      ROOT,
    );
    expect(info).toEqual({
      projectSlug: '-slug',
      sessionId: 'sess-1',
      isSubagent: true,
      agentId: 'x',
    });
  });

  it('reconnaît un sous-agent de workflow (chemin profond)', () => {
    const info = parseSessionPath(
      join(ROOT, '-slug', 'sess-1', 'subagents', 'workflows', 'wf_abc', 'agent-y.jsonl'),
      ROOT,
    );
    expect(info?.sessionId).toBe('sess-1');
    expect(info?.isSubagent).toBe(true);
    expect(info?.agentId).toBe('y');
  });

  it('renvoie null hors du répertoire projects', () => {
    expect(parseSessionPath('/autre/chemin/x.jsonl', ROOT)).toBeNull();
  });
});

describe('agentIdFromPath', () => {
  it('extrait l’identifiant d’un transcript d’agent', () => {
    expect(agentIdFromPath(join(ROOT, '-slug', 'sess', 'subagents', 'agent-a1b2.jsonl'))).toBe(
      'a1b2',
    );
  });

  it('accepte un agent de workflow imbriqué', () => {
    expect(
      agentIdFromPath(join(ROOT, '-slug', 'sess', 'subagents', 'workflows', 'wf_1', 'agent-z.jsonl')),
    ).toBe('z');
  });

  // Fichier réellement présent sur disque : sans garde, il serait ingéré comme un agent
  // « journal », en collision de clé primaire entre deux workflows d'une même session.
  it('rejette le journal d’un workflow', () => {
    expect(
      agentIdFromPath(join(ROOT, '-slug', 'sess', 'subagents', 'workflows', 'wf_1', 'journal.jsonl')),
    ).toBeNull();
  });

  it('rejette un fichier hors du répertoire subagents', () => {
    expect(agentIdFromPath(join(ROOT, '-slug', 'sess', 'tool-results', 'agent-x.jsonl'))).toBeNull();
    expect(agentIdFromPath(join(ROOT, '-slug', 'memory', 'agent-x.jsonl'))).toBeNull();
  });
});

describe('readAgentMeta', () => {
  it('lit le meta jumeau du transcript', () => {
    const dir = makeTempDir();
    const transcript = join(dir, 'agent-abc.jsonl');
    writeFileSync(
      agentMetaPathFor(transcript),
      JSON.stringify({ agentType: 'plan-code', description: 'RELECTURE-PLAN X', spawnDepth: 1 }),
    );
    expect(readAgentMeta(transcript)).toMatchObject({
      agentType: 'plan-code',
      description: 'RELECTURE-PLAN X',
    });
  });

  it('renvoie null si le meta est absent ou corrompu', () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    expect(readAgentMeta(join(dir, 'agent-absent.jsonl'))).toBeNull();

    const broken = join(dir, 'agent-broken.jsonl');
    writeFileSync(agentMetaPathFor(broken), '{ pas du json');
    expect(readAgentMeta(broken)).toBeNull();
  });
});

describe('agentTitle', () => {
  it('privilégie la description, puis le type, puis l’identifiant', () => {
    expect(agentTitle({ description: 'Titre', agentType: 'plan-code' }, 'a1')).toBe('Titre');
    // Les agents de workflow n'ont pas de description.
    expect(agentTitle({ agentType: 'workflow-subagent' }, 'a1')).toBe('workflow-subagent');
    expect(agentTitle(null, 'a1')).toBe('a1');
  });
});

describe('pathToSlug', () => {
  it('remplace les séparateurs par des tirets', () => {
    expect(pathToSlug('/home/user/projets/demo')).toBe('-home-user-projets-demo');
  });
});

describe('prettyProject', () => {
  it('privilégie les deux derniers segments du cwd', () => {
    expect(prettyProject('-slug', '/home/user/projets/demo')).toBe('projets/demo');
  });

  it('retombe sur le slug sans cwd', () => {
    expect(prettyProject('-slug', null)).toBe('-slug');
  });
});
