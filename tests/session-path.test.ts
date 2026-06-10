import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseSessionPath,
  pathToSlug,
  prettyProject,
} from '../src/parser/session-path.js';

const ROOT = '/home/user/.claude/projects';

describe('parseSessionPath', () => {
  it('reconnaît une session principale', () => {
    const info = parseSessionPath(join(ROOT, '-home-user-projets-demo', 'abc.jsonl'), ROOT);
    expect(info).toEqual({
      projectSlug: '-home-user-projets-demo',
      sessionId: 'abc',
      isSubagent: false,
    });
  });

  it('reconnaît un transcript de sous-agent', () => {
    const info = parseSessionPath(
      join(ROOT, '-slug', 'sess-1', 'subagents', 'agent-x.jsonl'),
      ROOT,
    );
    expect(info).toEqual({ projectSlug: '-slug', sessionId: 'sess-1', isSubagent: true });
  });

  it('reconnaît un sous-agent de workflow (chemin profond)', () => {
    const info = parseSessionPath(
      join(ROOT, '-slug', 'sess-1', 'subagents', 'workflows', 'wf_abc', 'agent-y.jsonl'),
      ROOT,
    );
    expect(info?.sessionId).toBe('sess-1');
    expect(info?.isSubagent).toBe(true);
  });

  it('renvoie null hors du répertoire projects', () => {
    expect(parseSessionPath('/autre/chemin/x.jsonl', ROOT)).toBeNull();
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
