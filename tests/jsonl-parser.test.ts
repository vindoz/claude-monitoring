import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readJsonlFromLine, splitCompleteLines } from '../src/parser/jsonl-parser.js';
import { makeTempDir } from './helpers.js';

describe('splitCompleteLines', () => {
  it('retourne les lignes complètes (saut final présent)', () => {
    expect(splitCompleteLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('écarte une dernière ligne incomplète (écriture en cours)', () => {
    expect(splitCompleteLines('a\nb')).toEqual(['a']);
  });

  it('gère un contenu vide', () => {
    expect(splitCompleteLines('')).toEqual([]);
  });
});

describe('readJsonlFromLine', () => {
  it('parse les events et compte les lignes corrompues', () => {
    const dir = makeTempDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, '{"type":"assistant"}\nligne cassée\n{"type":"ai-title"}\n');
    const res = readJsonlFromLine(file, 0);
    expect(res.parsedCount).toBe(2);
    expect(res.corruptedCount).toBe(1);
    expect(res.totalLines).toBe(3);
  });

  it('reprend à partir d’une ligne donnée', () => {
    const dir = makeTempDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, '{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
    const res = readJsonlFromLine(file, 2);
    expect(res.events).toHaveLength(1);
    expect(res.events[0].event.type).toBe('c');
    expect(res.totalLines).toBe(3);
  });
});
