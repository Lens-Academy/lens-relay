import type { Fingerprint } from './bridge/protocol';

export interface Candidate {
  position: number;
  score: number;
}

const MAX_CANDIDATES = 8;
const MAX_PROBES = 5;
const TOLERANCE_PX = 20;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ProbeRunner {
  /** Renders `sourceWithProbe` and reports the rect of `<!--lens-probe TOKEN-->`. */
  run(sourceWithProbe: string, token: string): Promise<Rect | null>;
  dispose(): void;
}

export type VerifyResult =
  | { kind: 'placed'; position: number }
  | { kind: 'manual'; candidates: Candidate[] };

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
const MARKDOWN_DELIMITER_CHARS = new Set(['`', '*', '_', '~']);

export function scoreCandidates(source: string, fp: Fingerprint): Candidate[] {
  const candidatesByPosition = new Map<number, Candidate>();
  const addCandidate = (position: number, score: number): void => {
    const existing = candidatesByPosition.get(position);
    if (!existing || score > existing.score) candidatesByPosition.set(position, { position, score });
  };
  for (const context of candidateContexts(fp)) {
    const needle = context.before + context.after;
    if (needle.length === 0) continue;
    let from = 0;
    while (true) {
      const idx = source.indexOf(needle, from);
      if (idx === -1) break;
      const position = idx + context.before.length;
      const score = context.before.length + context.after.length + context.bonus + ancestorBonus(source, position, fp);
      addCandidate(position, score);
      from = idx + 1;
    }
  }
  const rendered = renderTextIndex(source);
  for (const context of candidateContexts(fp)) {
    const needle = context.before + context.after;
    if (needle.length === 0) continue;
    let from = 0;
    while (true) {
      const idx = rendered.text.indexOf(needle, from);
      if (idx === -1) break;
      const renderedPosition = idx + context.before.length;
      const position = rendered.boundaries[renderedPosition];
      if (position !== undefined) {
        const score = context.before.length + context.after.length + context.bonus + ancestorBonus(source, position, fp);
        addCandidate(position, score);
      }
      from = idx + 1;
    }
  }
  const out = Array.from(candidatesByPosition.values());
  out.sort((a, b) => b.score - a.score || a.position - b.position);
  return out.slice(0, MAX_CANDIDATES);
}

function renderTextIndex(source: string): { text: string; boundaries: number[] } {
  let text = '';
  const boundaries: number[] = [0];
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? source.length : end + 3;
      boundaries[text.length] = i;
      continue;
    }
    if (source[i] === '<') {
      const end = source.indexOf('>', i + 1);
      i = end === -1 ? source.length : end + 1;
      boundaries[text.length] = i;
      continue;
    }
    if (MARKDOWN_DELIMITER_CHARS.has(source[i])) {
      const delimiter = source[i];
      while (source[i] === delimiter) i += 1;
      boundaries[text.length] = i;
      continue;
    }
    const entity = decodeHtmlEntityAt(source, i);
    if (entity) {
      for (const char of entity.text) {
        boundaries[text.length] = i;
        text += char;
        boundaries[text.length] = entity.end;
      }
      i = entity.end;
      continue;
    }
    boundaries[text.length] = i;
    text += source[i];
    i += 1;
    boundaries[text.length] = i;
  }
  boundaries[text.length] = source.length;
  return { text, boundaries };
}

function decodeHtmlEntityAt(source: string, position: number): { text: string; end: number } | null {
  if (source[position] !== '&') return null;
  const semi = source.indexOf(';', position + 1);
  if (semi === -1 || semi - position > 32) return null;
  const body = source.slice(position + 1, semi);
  const numeric = /^#(\d+)$/.exec(body);
  if (numeric) {
    const codePoint = Number(numeric[1]);
    if (!Number.isFinite(codePoint)) return null;
    return { text: String.fromCodePoint(codePoint), end: semi + 1 };
  }
  const hex = /^#x([0-9a-f]+)$/i.exec(body);
  if (hex) {
    const codePoint = Number.parseInt(hex[1], 16);
    if (!Number.isFinite(codePoint)) return null;
    return { text: String.fromCodePoint(codePoint), end: semi + 1 };
  }
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  const text = named[body];
  return text ? { text, end: semi + 1 } : null;
}

function candidateContexts(fp: Fingerprint): Array<{ before: string; after: string; bonus: number }> {
  const out: Array<{ before: string; after: string; bonus: number }> = [];
  const seen = new Set<string>();
  for (const size of [Number.POSITIVE_INFINITY, 10, 5]) {
    const before = size === Number.POSITIVE_INFINITY ? fp.before : fp.before.slice(-size);
    const after = size === Number.POSITIVE_INFINITY ? fp.after : fp.after.slice(0, size);
    const key = `${before}\0${after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      before,
      after,
      bonus: 0,
    });
  }
  return out;
}

export function makeProbeToken(): string {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyByProbe(
  source: string,
  candidates: Candidate[],
  fp: Fingerprint,
  runner: ProbeRunner,
): Promise<VerifyResult> {
  for (const candidate of candidates.slice(0, MAX_PROBES)) {
    const token = makeProbeToken();
    const marker = `<!--lens-probe ${token}-->`;
    const sourceWithProbe = source.slice(0, candidate.position) + marker + source.slice(candidate.position);
    const rect = await runner.run(sourceWithProbe, token);
    if (rect && rectsOverlap(rect, fp.clickRect, TOLERANCE_PX)) {
      return { kind: 'placed', position: candidate.position };
    }
  }
  return { kind: 'manual', candidates };
}

function rectsOverlap(a: Rect, b: Rect, tolerancePx: number): boolean {
  return !(
    a.x + a.w + tolerancePx < b.x
    || b.x + b.w + tolerancePx < a.x
    || a.y + a.h + tolerancePx < b.y
    || b.y + b.h + tolerancePx < a.y
  );
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
