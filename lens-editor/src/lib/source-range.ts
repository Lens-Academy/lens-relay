// Where a corpus paragraph lives in its source file. A corpus row has the 1-based line its
// paragraph starts on and the paragraph's rendered words (markdown stripped), both from the
// staging commit the corpus was built at; the live file may have moved since.

/** Letters and digits only, lower-cased, without link targets: rendered words and their
 *  markdown compare equal (`[a](url)` and `[[target|a]]` read as `a`). */
const norm = (s: string) => s
  .replace(/^[ \t]*(?:[\w-]+::|\[\^[^\]]*\]:|\d+[.)]|[-*+>])[ \t]*/gm, '')
  .replace(/\]\([^)]*\)/g, '').replace(/\[\[[^\]|]*\|/g, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const PROBE = 24;

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1);
  return out;
}

/** The block starting at line index `i`: up to the next blank line or heading. */
function blockFrom(text: string, starts: number[], i: number): { from: number; to: number } {
  const lineEnd = (k: number) => (k + 1 < starts.length ? starts[k + 1] - 1 : text.length);
  let k = i;
  while (k + 1 < starts.length) {
    const next = text.slice(starts[k + 1], lineEnd(k + 1));
    if (!next.trim() || /^#{1,6}\s/.test(next)) break;
    k++;
  }
  return { from: starts[i], to: lineEnd(k) };
}

/** The source range of the paragraph that starts on `line` and reads `words`; if that line
 *  no longer starts it, the first block whose text starts with the same words; else null. */
export function paragraphRange(text: string, line: number, words: string): { from: number; to: number } | null {
  const starts = lineStarts(text);
  const probe = norm(words).slice(0, PROBE);
  if (!probe) return null;
  const fits = (i: number) => norm(text.slice(starts[i], blockFrom(text, starts, i).to)).startsWith(probe);
  if (line >= 1 && line - 1 < starts.length && fits(line - 1)) return blockFrom(text, starts, line - 1);
  for (let i = 0; i < starts.length; i++) if (fits(i)) return blockFrom(text, starts, i);
  return null;
}
