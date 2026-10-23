import { describe, expect, it } from 'vitest';
import { diffVersions, historyPath } from './history-api';

describe('historyPath', () => {
  it('gives the server path for a Lens Edu file', () => {
    expect(historyPath('/Lens Edu/Lenses/a.md')).toBe('Lens Edu/Lenses/a.md');
  });
  it.each([undefined, '', '/Lens/09-Transcripts/x.md', '/Lens Edux/a.md', 'Lens Edu/a.md'])('has none for %j', p => {
    expect(historyPath(p)).toBeNull();
  });
});

describe('diffVersions', () => {
  it('marks added and removed words and counts them', () => {
    const d = diffVersions('the cat sat\n', 'the black cat stood\n');
    expect(d.parts.map(p => [p.kind, p.text])).toEqual([
      ['same', 'the '],
      ['added', 'black '],
      ['same', 'cat '],
      ['removed', 'sat'],
      ['added', 'stood'],
      ['same', '\n'],
    ]);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
  });
  it('treats a missing base as all added', () => {
    const d = diffVersions(null, 'a b');
    expect(d.parts).toEqual([{ kind: 'added', text: 'a b' }]);
    expect([d.added, d.removed]).toEqual([2, 0]);
  });
});
