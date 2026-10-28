import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { writeText } from './ytext';

function written(before: string, after: string): string {
  const doc = new Y.Doc();
  const t = doc.getText('t');
  t.insert(0, before);
  writeText(t, () => after);
  return t.toString();
}

describe('writeText: the file ends as the change says', () => {
  // T7, 2026-10-27: dropping a draft presentation block left "  p" behind, because the
  // shared start ("  p" of "presentation") and the shared end overlapped in the new text.
  it('drops a block whose first letters match the line after it', () => {
    const before = 'draft:\n  x: 1\n  presentation:\n    context: lens\n  pass_below: 0.15\n';
    const after = 'draft:\n  x: 1\n  pass_below: 0.15\n';
    expect(written(before, after)).toBe(after);
  });

  it('writes any change exactly, however its start and end overlap', () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const word = () => Array.from({ length: rand(9) }, () => 'ab\n'[rand(3)]).join('');
    for (let i = 0; i < 3000; i++) {
      const [before, after] = [word(), word()];
      expect(written(before, after), JSON.stringify({ before, after })).toBe(after);
    }
  });
});
