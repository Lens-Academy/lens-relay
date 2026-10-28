import { describe, expect, it } from 'vitest';
import { diffVersions } from './history-api';
import { changeOffsets, diffDecorations } from './history-doc';

describe('diffDecorations', () => {
  it('marks added runs at their place in the new text and puts removed text where it was', () => {
    const { parts } = diffVersions('the cat sat\n', 'the black cat stood\n');
    const out: [number, number, string][] = [];
    diffDecorations(parts).between(0, 1e9, (from, to, d) => {
      const w = (d.spec.widget as { text?: string } | undefined)?.text;
      out.push([from, to, w !== undefined ? `-${w}` : d.spec.class]);
    });
    expect(out).toEqual([
      [4, 10, 'lens-history-added'],     // "black "
      [14, 14, '-sat'],
      [14, 19, 'lens-history-added'],    // "stood"
    ]);
    expect('the black cat stood\n'.slice(4, 10)).toBe('black ');
  });
});

describe('changeOffsets', () => {
  it('gives where each change starts in the new text, once per run of adjacent edits', () => {
    expect(changeOffsets(diffVersions('the cat sat\n', 'the black cat stood\n').parts)).toEqual([4, 14]);
    expect(changeOffsets(diffVersions('same', 'same').parts)).toEqual([]);
    expect(changeOffsets(diffVersions('a b', 'a\n\nb').parts)).toEqual([]);   // spacing only
  });
});
