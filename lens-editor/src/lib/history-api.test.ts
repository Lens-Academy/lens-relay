import { describe, expect, it } from 'vitest';
import { historyPath, previewText, versionPair } from './history-api';

describe('historyPath', () => {
  it('gives the server path for a Lens Edu file', () => {
    expect(historyPath('/Lens Edu/Lenses/a.md')).toBe('Lens Edu/Lenses/a.md');
  });
  it.each([undefined, '', '/Lens/09-Transcripts/x.md', '/Lens Edux/a.md', 'Lens Edu/a.md'])('has none for %j', p => {
    expect(historyPath(p)).toBeNull();
  });
});

describe('versionPair', () => {
  const v = (sha: string, ts: number, author: string | null = null) => ({ sha, ts, author });
  const session = {
    start: 1, end: 3, authors: ['Elias'], unknown: true, head: 'c', base: 'z', summary: null,
    versions: [v('c', 3, 'Elias'), v('b', 2), v('a', 1)],
  };
  it('compares a whole session against the session before it', () => {
    expect(versionPair(session, null)).toEqual({ head: 'c', base: 'z', ts: 3, authors: ['Elias'] });
  });
  it('compares one save against the save before it, and the oldest against the session base', () => {
    expect(versionPair(session, 0)).toEqual({ head: 'c', base: 'b', ts: 3, authors: ['Elias'] });
    expect(versionPair(session, 1)).toEqual({ head: 'b', base: 'a', ts: 2, authors: [] });
    expect(versionPair(session, 2)).toEqual({ head: 'a', base: 'z', ts: 1, authors: [] });
  });
});

describe('previewText', () => {
  it.each([
    [{ removed: 'causes', added: 'leads' }, 'causes → leads'],
    [{ removed: '', added: 'new words' }, '+ new words'],
    [{ removed: 'old words', added: '' }, '− old words'],
    [{ removed: '', added: '' }, 'markup only'],
  ])('%j → %s', (first, text) => {
    expect(previewText(first)).toBe(text);
  });
});
