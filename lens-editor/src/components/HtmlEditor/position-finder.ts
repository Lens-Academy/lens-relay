import type { Fingerprint } from './bridge/protocol';

export interface Candidate {
  position: number;
  score: number;
}

const MAX_CANDIDATES = 8;

interface PathFrame {
  tag: string;
  index: number;
}

interface OpenFrame extends PathFrame {
  childCounts: Map<string, number>;
}

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

export function scoreCandidates(source: string, fp: Fingerprint): Candidate[] {
  const needle = fp.before + fp.after;
  if (needle.length === 0) return [];
  const out: Candidate[] = [];
  let from = 0;
  while (true) {
    const idx = source.indexOf(needle, from);
    if (idx === -1) break;
    const position = idx + fp.before.length;
    const score = fp.before.length + fp.after.length + ancestorBonus(source, position, fp);
    out.push({ position, score });
    from = idx + 1;
  }
  out.sort((a, b) => b.score - a.score || a.position - b.position);
  return out.slice(0, MAX_CANDIDATES);
}

function openPathAt(source: string, position: number): PathFrame[] {
  const stack: OpenFrame[] = [];
  const rootCounts = new Map<string, number>();
  const before = source.slice(0, position);
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(before)) !== null) {
    const [, slash, name, selfClose] = m;
    const tag = name.toLowerCase();
    if (slash === '/') {
      let idx = -1;
      for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex--) {
        if (stack[stackIndex].tag === tag) {
          idx = stackIndex;
          break;
        }
      }
      if (idx >= 0) stack.length = idx;
    } else {
      const counts = stack.at(-1)?.childCounts ?? rootCounts;
      const index = counts.get(tag) ?? 0;
      counts.set(tag, index + 1);
      if (!selfClose && !VOID_TAGS.has(tag)) {
        stack.push({ tag, index, childCounts: new Map() });
      }
    }
  }
  return stack.map(({ tag, index }) => ({ tag, index }));
}

function ancestorBonus(source: string, position: number, fp: Fingerprint): number {
  if (fp.ancestorPath.length === 0) return 0;
  const open = openPathAt(source, position);
  const expected = fp.ancestorPath.map(({ tag, index }) => ({ tag: tag.toLowerCase(), index }));
  const orderedBonus = orderedMatchBonus(open, expected);
  let suffixLength = 0;
  let suffixExactIndexCount = 0;
  let openIndex = open.length - 1;
  let expectedIndex = expected.length - 1;
  while (openIndex >= 0 && expectedIndex >= 0 && open[openIndex].tag === expected[expectedIndex].tag) {
    suffixLength++;
    if (open[openIndex].index === expected[expectedIndex].index) suffixExactIndexCount++;
    openIndex--;
    expectedIndex--;
  }
  const maxOrderedBonus = expected.length * 8;
  const orderedBand = maxOrderedBonus + 1;
  const suffixBand = (expected.length + 1) * orderedBand;
  return suffixLength * suffixBand + suffixExactIndexCount * orderedBand + orderedBonus;
}

function orderedMatchBonus(open: PathFrame[], expected: PathFrame[]): number {
  let bonus = 0;
  let from = 0;
  for (const expectedFrame of expected) {
    const idx = open.findIndex((openFrame, openIndex) => (
      openIndex >= from && openFrame.tag === expectedFrame.tag
    ));
    if (idx === -1) continue;
    bonus += 6;
    if (open[idx].index === expectedFrame.index) bonus += 2;
    from = idx + 1;
  }
  return bonus;
}
