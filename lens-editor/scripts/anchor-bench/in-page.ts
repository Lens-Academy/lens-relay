/**
 * Runs inside a rendered page for the anchor benchmark (bundled by run.ts).
 * Ground truth comes from invisible markers the harness wrote into the page
 * source: ZWJ + six ZWSP/ZWNJ bits + ZWJ. The text index ignores those
 * characters, so the anchoring code never sees them.
 */
import { buildTextIndex, offsetOfPoint } from '../../src/components/HtmlEditor/anchoring/text-index';
import { clickSpan, describeElement, describeSpan } from '../../src/components/HtmlEditor/anchoring/describe';
import { resolveAnchor } from '../../src/components/HtmlEditor/anchoring/resolve';
import type { HtmlAnchor } from '../../src/components/HtmlEditor/anchoring/types';

const ZWJ = '‍';

/** Every rendered position of each marker (scripts may copy text, e.g. a
 *  table of contents built from the headings). */
function markerOffsets(): Map<number, number[]> {
  const index = buildTextIndex(document.body);
  const out = new Map<number, number[]>();
  // Only text the reader sees: markers inside <script> data never render.
  for (const n of index.nodes) {
    const data = n.data;
    let from = 0;
    for (;;) {
      const at = data.indexOf(ZWJ, from);
      if (at < 0 || at + 8 > data.length) break;
      const bits = data.slice(at + 1, at + 7);
      if (data[at + 7] === ZWJ && /^[​‌]{6}$/.test(bits)) {
        const id = parseInt(Array.from(bits, c => (c === '‌' ? '1' : '0')).join(''), 2);
        out.set(id, [...(out.get(id) ?? []), offsetOfPoint(index, n, at + 8)]);
        from = at + 8;
      } else {
        from = at + 1;
      }
    }
  }
  return out;
}

export interface Created {
  id: number;
  anchor: HtmlAnchor;
  kind: string;
}

/** Comment on each marker: a click (sentence/block), a short or a long selection. */
export function createTextAnchors(): Created[] {
  const index = buildTextIndex(document.body);
  const out: Created[] = [];
  for (const [id, [at]] of markerOffsets()) {
    if (at >= index.text.length) continue;
    const kind = ['click', 'short', 'long'][id % 3];
    let span: { start: number; end: number } | null = null;
    if (kind === 'click') span = clickSpan(index, at);
    else {
      const words = kind === 'short' ? 1 + (id % 3) : 6 + (id % 7);
      let end = at;
      let seen = 0;
      while (end < index.text.length && seen < words) {
        end++;
        if (index.text[end] === ' ' || end === index.text.length) seen++;
      }
      span = { start: at, end };
    }
    const anchor = span ? describeSpan(index, span.start, span.end, window.innerWidth) : null;
    if (anchor) out.push({ id, anchor, kind });
  }
  return out;
}

export function createPins(): Created[] {
  return Array.from(document.querySelectorAll('[data-bench-id]')).flatMap(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return [];
    const id = Number(el.getAttribute('data-bench-id'));
    return [{ id, kind: 'pin', anchor: describeElement(el, { x: r.left + r.width / 3, y: r.top + r.height / 2 }, window.innerWidth) }];
  });
}

export interface Outcome {
  id: number;
  kind: string;
  state: string;
  correct: boolean | null;
  /** For inspecting failures: what was quoted, what it resolved to, and the
   *  text at the true spot. */
  quote?: string;
  found?: string;
  truth?: string;
}

export function resolveAll(created: Created[]): Outcome[] {
  const index = buildTextIndex(document.body);
  const truth = markerOffsets();
  return created.map(({ id, anchor, kind }) => {
    const res = resolveAnchor(document, index, anchor);
    if (res.kind === 'none') return { id, kind, state: 'orphaned', correct: null };
    if (res.kind === 'element') {
      const benchId = res.element.getAttribute('data-bench-id');
      return { id, kind, state: res.state, correct: benchId === String(id) };
    }
    const ts = truth.get(id) ?? [];
    const detail = {
      quote: anchor.kind === 'text' ? anchor.quote : '',
      found: index.text.slice(res.start, res.end),
      truth: ts.length === 0 ? '' : index.text.slice(Math.max(0, ts[0] - 30), ts[0] + 30),
    };
    return { id, kind, state: res.state, correct: ts.some(t => t >= res.start - 1 && t <= res.end), ...detail };
  });
}

export function hasMarker(id: number): boolean {
  return markerOffsets().has(id);
}
