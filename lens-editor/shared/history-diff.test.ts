import { describe, expect, it } from 'vitest';
import { authorLabel, diffVersions, summarize } from './history-diff';

describe('diffVersions', () => {
  it('marks added and removed words and counts them', () => {
    const d = diffVersions('the cat sat\n', 'the black cat stood\n');
    expect(d.parts.map(p => [p.kind, p.text])).toEqual([
      ['same', 'the '], ['added', 'black '], ['same', 'cat '], ['removed', 'sat'], ['added', 'stood'], ['same', '\n'],
    ]);
    expect([d.added, d.removed]).toEqual([2, 1]);
  });
  it('treats a missing base as all added', () => {
    const d = diffVersions(null, 'a b');
    expect(d.parts).toEqual([{ kind: 'added', text: 'a b' }]);
    expect([d.added, d.removed]).toEqual([2, 0]);
  });
});

describe('diffVersions on big files', () => {
  it('diffs words only inside changed lines, so unchanged lines cost nothing', () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} has some words in it`);
    const base = lines.join('\n');
    const text = lines.map((l, i) => (i === 2000 ? 'line 2000 has other words in it' : l)).join('\n');
    const t0 = performance.now();
    const d = diffVersions(base, text);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(d.parts.filter(p => p.kind !== 'same').map(p => [p.kind, p.text])).toEqual([['removed', 'some'], ['added', 'other']]);
    expect(d.parts.filter(p => p.kind !== 'removed').map(p => p.text).join('')).toBe(text);
    expect(d.parts.filter(p => p.kind !== 'added').map(p => p.text).join('')).toBe(base);
  });
  it('marks a block whose words all changed as a whole, without a word-by-word search', () => {
    const base = 'keep\n' + Array.from({ length: 300 }, (_, i) => `a${i} b${i} c${i} d${i}`).join('\n') + '\nkeep';
    const text = 'keep\n' + Array.from({ length: 300 }, (_, i) => `w${i} x${i} y${i} z${i}`).join('\n') + '\nkeep';
    const t0 = performance.now();
    const d = diffVersions(base, text);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(d.parts.map(p => p.kind)).toEqual(['same', 'removed', 'added', 'same']);
  });
  it('marks a huge rewritten block by whole lines instead of word by word', () => {
    const base = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n');
    const text = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n');
    const t0 = performance.now();
    const d = diffVersions(base, text);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(d.parts.map(p => p.kind)).toEqual(['removed', 'added']);
  });
});

describe('summarize', () => {
  it('counts places changed, merging edits fewer than four unchanged words apart', () => {
    expect(summarize('the cat sat', 'the black cat stood').changes).toBe(1);   // 1 word apart
    expect(summarize('a b c d e f g', 'X b c d e f Y').changes).toBe(2);       // 5 words apart
    expect(summarize('a b c d e f', 'X b c d e Y').changes).toBe(2);           // exactly 4 apart
    expect(summarize('a b c d e', 'X b c d Y').changes).toBe(1);               // 3 apart
  });
  it('previews the first change as removed and added text', () => {
    const s = summarize('a b c d e f g', 'X b c d e f Y');
    expect(s.first).toEqual({ removed: 'a', added: 'X' });
    expect([s.added, s.removed]).toEqual([2, 2]);
  });
  it('previews a merged change whole, trimmed and cut at 60 characters', () => {
    const long = 'word '.repeat(30);
    const s = summarize('start end', `start ${long}end`);
    expect(s.first!.removed).toBe('');
    expect(s.first!.added.length).toBeLessThanOrEqual(61);
    expect(s.first!.added.endsWith('…')).toBe(true);
    expect(summarize('the cat sat', 'the black cat stood').first).toEqual({ removed: 'sat', added: 'black … stood' });
  });
  it('previews suggestion text without its markup or author metadata', () => {
    const s = summarize('a b c', 'a {++{"author":"Luc\'s AI","timestamp":1790449050412}@@fresh++} b c');
    expect(s.first).toEqual({ removed: '', added: 'fresh' });
    expect(summarize('x', 'x {~~old~>new~~}').first).toEqual({ removed: '', added: 'old → new' });
  });
  it('ignores suggestion metadata, even when the author name has a space in it', () => {
    const meta = (who: string, t: number) => `{++{"author":"${who}","timestamp":${t}}@@`;
    expect(summarize(`a ${meta("Turner's AI", 1)}x++} b`, `a ${meta("Turner's AI", 2)}x++} b`).changes).toBe(0);
    expect(summarize('a b', `a ${meta("Turner's AI", 1)}new words++} b`).first).toEqual({ removed: '', added: 'new words' });
  });
  it('says markup only when a change touched nothing but suggestion marks', () => {
    const s = summarize('a {++fresh++} b', 'a fresh b');
    expect(s.changes).toBe(1);
    expect(s.first).toEqual({ removed: '', added: '' });
  });
  it('previews the first change that has a letter or digit, still counting the rest', () => {
    const s = summarize('a b c d e f g', 'a - b c d e f Z');
    expect(s.changes).toBe(2);
    expect(s.first).toEqual({ removed: 'g', added: 'Z' });
    expect(summarize('a b', 'a : b').first).toEqual({ removed: '', added: ':' });   // nothing better: keep it
  });
  it('does not count an edit that only changes spacing or blank lines', () => {
    const s = summarize('a b\nc', 'a b\n\nc');
    expect([s.changes, s.first]).toEqual([0, null]);
    expect(summarize('a b c d e f', 'a b\n\nc d e Z').changes).toBe(1);
  });
  it('says nothing changed for identical text, and all added for a first version', () => {
    expect(summarize('same', 'same')).toEqual({ changes: 0, added: 0, removed: 0, first: null });
    expect(summarize(null, 'new file')).toEqual({ changes: 1, added: 2, removed: 0, first: { removed: '', added: 'new file' } });
  });
});

describe('authorLabel', () => {
  it.each([
    ['Elias', 'Elias'],
    ['ai:opus-5.5:Andreas', 'Andreas (AI)'],
    ['ai:unknown:Lens EA', 'Lens EA (AI)'],
    ['ai:opus-5.5:James agent ready-41', 'James agent ready-41 (AI)'],
    ['ai:weird', 'ai:weird'],
  ])('%s → %s', (raw, label) => {
    expect(authorLabel(raw)).toBe(label);
  });
});
