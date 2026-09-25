/**
 * The page's visible text as one string, with a map back to DOM positions.
 *
 * Whitespace runs collapse to one space, and a space separates block-level
 * elements (so `<li>One</li><li>Two</li>` reads "One Two", as a person sees
 * it). Anchors store offsets and quotes in this normalized text; the relay's
 * static-text extractor (`html_comments.rs`) follows the same rules closely
 * enough for its checks.
 */

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'IFRAME', 'OBJECT', 'HEAD', 'TITLE',
]);

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'BR', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR',
  'UL', 'LEGEND', 'BUTTON', 'LABEL', 'SVG', 'IMG', 'CANVAS', 'VIDEO', 'AUDIO', 'INPUT',
]);

/** Marks elements the bridge adds to the page; never part of the page's text. */
export const OVERLAY_ATTRIBUTE = 'data-lens-overlay';

export interface TextIndex {
  text: string;
  /** Per character of `text`: index into `nodes`, or -1 for a space that
   *  stands for collapsed whitespace or a block boundary. */
  nodeOf: Int32Array;
  /** Per character of `text`: offset inside its node (unused for spaces). */
  offsetOf: Int32Array;
  /** Indices of the characters that come from a text node (not spaces). */
  real: Int32Array;
  nodes: Text[];
}

function isWhitespace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || code === 160 || code === 0x2028 || code === 0x2029
    || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000;
}

/** Zero-width characters and soft hyphens: invisible, and they would break
 *  exact matching of text someone copied from the page. */
function isInvisible(code: number): boolean {
  return code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff || code === 0xad;
}

export function isSkippedElement(el: Element): boolean {
  return SKIP_TAGS.has(el.tagName.toUpperCase()) || el.hasAttribute(OVERLAY_ATTRIBUTE);
}

export function isBlockElement(el: Element): boolean {
  return BLOCK_TAGS.has(el.tagName.toUpperCase());
}

/** Normalize a string the way the index does (quotes typed by agents, selections). */
export function normalizeText(input: string): string {
  let out = '';
  let pendingSpace = false;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (isInvisible(code)) continue;
    if (isWhitespace(code)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += ' ';
    pendingSpace = false;
    out += input[i];
  }
  return out;
}

export function buildTextIndex(root: Element): TextIndex {
  const doc = root.ownerDocument;
  const TEXT = 3;
  const walker = doc.createTreeWalker(root, 0x1 | 0x4 /* SHOW_ELEMENT | SHOW_TEXT */, {
    acceptNode(node) {
      if (node.nodeType !== TEXT && isSkippedElement(node as Element)) return 2; // FILTER_REJECT
      return 1; // FILTER_ACCEPT
    },
  });

  const chars: string[] = [];
  const nodeOf: number[] = [];
  const offsetOf: number[] = [];
  const nodes: Text[] = [];
  // A space owed for whitespace or a block boundary, emitted lazily before
  // the next visible character so runs collapse to one.
  let pendingSpace = false;
  const openBlocks: Element[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    while (openBlocks.length > 0 && !openBlocks[openBlocks.length - 1].contains(node)) {
      openBlocks.pop();
      pendingSpace = true;
    }
    if (node.nodeType !== TEXT) {
      if (isBlockElement(node as Element)) {
        pendingSpace = true;
        openBlocks.push(node as Element);
      }
      continue;
    }
    const textNode = node as Text;
    const data = textNode.data;
    let nodeIndex = -1;
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (isInvisible(code)) continue;
      if (isWhitespace(code)) {
        pendingSpace = true;
        continue;
      }
      if (pendingSpace && chars.length > 0) {
        chars.push(' ');
        nodeOf.push(-1);
        offsetOf.push(0);
      }
      pendingSpace = false;
      if (nodeIndex < 0) {
        nodeIndex = nodes.length;
        nodes.push(textNode);
      }
      chars.push(data[i]);
      nodeOf.push(nodeIndex);
      offsetOf.push(i);
    }
  }
  const real: number[] = [];
  for (let i = 0; i < nodeOf.length; i++) if (nodeOf[i] >= 0) real.push(i);
  return {
    text: chars.join(''),
    nodeOf: Int32Array.from(nodeOf),
    offsetOf: Int32Array.from(offsetOf),
    real: Int32Array.from(real),
    nodes,
  };
}

/** DOM boundary for a text offset: `start` is the first character at or
 *  after `offset`, `end` is just after the last character before it. */
export function domPoint(index: TextIndex, offset: number, edge: 'start' | 'end'): { node: Text; offset: number } | null {
  const n = index.text.length;
  if (edge === 'start') {
    for (let i = Math.max(0, offset); i < n; i++) {
      const node = index.nodeOf[i];
      if (node >= 0) return { node: index.nodes[node], offset: index.offsetOf[i] };
    }
    return null;
  }
  for (let i = Math.min(n, offset) - 1; i >= 0; i--) {
    const node = index.nodeOf[i];
    if (node >= 0) return { node: index.nodes[node], offset: index.offsetOf[i] + 1 };
  }
  return null;
}

export function rangeFor(index: TextIndex, start: number, end: number): Range | null {
  if (end <= start) return null;
  const from = domPoint(index, start, 'start');
  const to = domPoint(index, end, 'end');
  if (!from || !to) return null;
  const range = from.node.ownerDocument.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

/** Index offset of a DOM boundary point: the first text-node character at
 *  or after it (or the text length when there is none). */
export function offsetOfPoint(index: TextIndex, node: Node, offset: number): number {
  const doc = node.ownerDocument;
  const real = index.real;
  if (!doc || real.length === 0) return 0;
  const probe = doc.createRange();
  let lo = 0;
  let hi = real.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const k = real[mid];
    probe.setStart(index.nodes[index.nodeOf[k]], index.offsetOf[k]);
    probe.collapse(true);
    let cmp: number;
    try {
      // -1: the point is before this character, 0: at it, 1: after it.
      cmp = probe.comparePoint(node, offset);
    } catch {
      cmp = 1;
    }
    if (cmp === 1) lo = mid + 1;
    else hi = mid;
  }
  return lo < real.length ? real[lo] : index.text.length;
}

/** Offsets [start, end) of the index text inside `el`, or null when it holds none. */
export function textSpanOf(index: TextIndex, el: Element): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  for (let i = 0; i < index.text.length; i++) {
    const nodeIdx = index.nodeOf[i];
    if (nodeIdx < 0) continue;
    if (el.contains(index.nodes[nodeIdx])) {
      if (start < 0) start = i;
      end = i + 1;
    } else if (start >= 0) {
      break; // an element's text is contiguous in document order
    }
  }
  return start < 0 ? null : { start, end };
}
