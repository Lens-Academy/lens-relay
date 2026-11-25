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

/** The source range of the block that `words` (a paragraph or a sentence of one) sit in: the
 *  block at `line` if it starts with them, then the first block that starts with them, then
 *  the block at `line` holding them, then the first block holding them; else null. A sentence
 *  can start mid-line, so starting with them is not required, only preferred. */
export function paragraphRange(text: string, line: number, words: string): { from: number; to: number } | null {
  const starts = lineStarts(text);
  const probe = norm(words).slice(0, PROBE);
  if (!probe) return null;
  const block = (i: number) => norm(text.slice(starts[i], blockFrom(text, starts, i).to));
  const at = line - 1;
  const ok = at >= 0 && at < starts.length;
  // A block that merely holds them is searched only from block starts, so it is a whole block.
  const blockStart = (i: number) => i === 0 || !text.slice(starts[i - 1], starts[i]).trim() || /^#{1,6}\s/.test(text.slice(starts[i - 1], starts[i]));
  const passes: [(b: string) => boolean, (i: number) => boolean][] = [[(b) => b.startsWith(probe), () => true], [(b) => b.includes(probe), blockStart]];
  for (const [test, from] of passes) {
    if (ok && test(block(at))) return blockFrom(text, starts, at);
    for (let i = 0; i < starts.length; i++) if (from(i) && test(block(i))) return blockFrom(text, starts, i);
  }
  return null;
}
