/**
 * Describe what someone pointed at in the rendered page as an anchor that can
 * be found again after the page changes (see types.ts for the format).
 */
import { MAX_CONTEXT_CHARS, MAX_QUOTE_CHARS, type ElementAnchor, type ScopeSelector, type TextAnchor } from './types';
import { buildTextIndex, isBlockElement, isSkippedElement, normalizeText, offsetOfPoint, textSpanOf, type TextIndex } from './text-index';

const CONTEXT_STEP = 32;
/** Blocks at most this long are commented on whole when clicked; longer ones
 *  by the sentence under the pointer. */
const WHOLE_BLOCK_CHARS = 160;
const MAX_OCCURRENCES = 1000;

/** Ids that frameworks generate per render (React useId, Radix, Headless UI…)
 *  are not stable across renders, so they make poor anchors. */
const GENERATED_ID = /^(?::|«|r\d|radix-|headlessui-|react-|mui-|ember\d|ext-gen|__|[0-9a-f]{8,}$)/i;

export function occurrences(text: string, needle: string, limit = MAX_OCCURRENCES): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let from = 0;
  while (out.length < limit) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    out.push(at);
    from = at + 1;
  }
  return out;
}

function cssEscape(win: Window | null, value: string): string {
  const css = (win as (Window & { CSS?: { escape?: (v: string) => string } }) | null)?.CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

function queryCount(doc: Document, selector: string): number {
  try {
    return doc.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

export function usableId(el: Element): string | undefined {
  const id = el.id;
  if (!id || GENERATED_ID.test(id)) return undefined;
  const doc = el.ownerDocument;
  return queryCount(doc, `#${cssEscape(doc.defaultView, id)}`) === 1 ? id : undefined;
}

function usableLensId(el: Element): string | undefined {
  const value = el.getAttribute('data-lens-id');
  if (!value) return undefined;
  const doc = el.ownerDocument;
  return queryCount(doc, `[data-lens-id="${cssEscape(doc.defaultView, value)}"]`) === 1 ? value : undefined;
}

/** Shortest selector (walking up from `el`) that matches only `el`. */
export function uniqueCssPath(el: Element): string | undefined {
  const doc = el.ownerDocument;
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 14; depth++) {
    if (cur === doc.body || cur === doc.documentElement) {
      parts.unshift(cur.tagName.toLowerCase());
    } else {
      const id = usableId(cur);
      if (id) {
        parts.unshift(`#${cssEscape(doc.defaultView, id)}`);
      } else {
        const tag = cur.tagName.toLowerCase();
        const parent: Element | null = cur.parentElement;
        const sameTag = parent ? Array.from(parent.children).filter(c => c.tagName === cur!.tagName) : [];
        parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(cur) + 1})` : tag);
      }
    }
    const selector = parts.join(' > ');
    if (queryCount(doc, selector) === 1 && doc.querySelector(selector) === el) return selector;
    if (parts[0].startsWith('#') || cur === doc.documentElement) break;
    cur = cur.parentElement;
  }
  return undefined;
}

function elementOf(node: Node): Element | null {
  return node.nodeType === 1 ? node as Element : node.parentElement;
}

/** Nearest ancestor (inclusive when `inclusive`) with a stable identity.
 *  Containers holding (nearly) the whole page, like a React `#root`, say
 *  nothing about where in it the target is, so they never serve as scope. */
export function describeScope(start: Element | null, inclusive = true): ScopeSelector | undefined {
  let cur: Element | null = inclusive ? start : start?.parentElement ?? null;
  const body = start?.ownerDocument.body;
  const pageChars = body?.textContent?.length ?? 0;
  while (cur && cur !== body) {
    if (pageChars > 0 && (cur.textContent?.length ?? 0) >= pageChars * 0.9) break;
    const id = usableId(cur);
    const lensId = id ? undefined : usableLensId(cur);
    if (id || lensId) {
      return { ...(id ? { id } : {}), ...(lensId ? { lensId } : {}), tag: cur.tagName.toLowerCase() };
    }
    cur = cur.parentElement;
  }
  return undefined;
}

/** Nearest block ancestor's unique CSS path, as a scope for duplicates. */
function blockScope(el: Element | null): ScopeSelector | undefined {
  let cur = el;
  const body = el?.ownerDocument.body;
  while (cur && cur !== body && !isBlockElement(cur)) cur = cur.parentElement;
  if (!cur || cur === body) return undefined;
  const css = uniqueCssPath(cur);
  return css ? { css, tag: cur.tagName.toLowerCase() } : undefined;
}

/** Text of the nearest heading before `node`. */
export function sectionOf(node: Node): string | undefined {
  const doc = node.ownerDocument;
  if (!doc?.body) return undefined;
  const headings = Array.from(doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  let found: Element | undefined;
  for (const heading of headings) {
    if (heading.contains(node)) return undefined; // the target is itself a heading
    const pos = heading.compareDocumentPosition(node);
    if (pos & 4 /* DOCUMENT_POSITION_FOLLOWING */) found = heading;
    else break;
  }
  const text = found ? normalizeText(found.textContent ?? '') : '';
  return text ? text.slice(0, 120) : undefined;
}

function contextMatches(text: string, at: number, length: number, prefix: string, suffix: string): boolean {
  return text.slice(Math.max(0, at - prefix.length), at) === prefix
    && text.slice(at + length, at + length + suffix.length) === suffix;
}

/** A text anchor for index offsets [start, end). */
export function describeSpan(index: TextIndex, start: number, end: number, viewportWidth?: number): TextAnchor | null {
  const text = index.text;
  while (start < end && text[start] === ' ') start++;
  while (end > start && text[end - 1] === ' ') end--;
  if (end <= start) return null;
  if (end - start > MAX_QUOTE_CHARS) {
    end = start + MAX_QUOTE_CHARS;
    if (/[\ud800-\udbff]/.test(text[end - 1])) end--;
    while (end > start && text[end - 1] === ' ') end--;
  }
  const quote = text.slice(start, end);
  const length = end - start;

  const matches = occurrences(text, quote);
  let prefix = '';
  let suffix = '';
  let ambiguous: number[] = matches;
  for (let size = CONTEXT_STEP; size <= MAX_CONTEXT_CHARS; size += CONTEXT_STEP) {
    prefix = text.slice(Math.max(0, start - size), start);
    suffix = text.slice(end, end + size);
    ambiguous = matches.filter(at => contextMatches(text, at, length, prefix, suffix));
    // Keep at least one step of context even for unique quotes: it is what
    // lets a reworded quote be found again.
    if (ambiguous.length <= 1) break;
    if (start - size <= 0 && end + size >= text.length) break;
  }

  const startNode = index.nodeOf[start] >= 0 ? index.nodes[index.nodeOf[start]] : null;
  const startEl = startNode ? elementOf(startNode) : null;
  let scope = describeScope(startEl);
  let ordinal: number | undefined;
  if (ambiguous.length > 1) {
    // Verbatim repeats with identical surroundings: the nearest block's CSS
    // path, then the ordinal, are all that tell them apart.
    scope = scope ?? blockScope(startEl);
    ordinal = ambiguous.indexOf(start);
  }

  return {
    v: 1,
    kind: 'text',
    quote,
    prefix,
    suffix,
    ...(scope ? { scope } : {}),
    ...(ordinal !== undefined && ordinal >= 0 ? { ordinal } : {}),
    position: { start, end, total: text.length },
    ...(startNode && sectionOf(startNode) ? { section: sectionOf(startNode) } : {}),
    ...(viewportWidth ? { viewportWidth: Math.round(viewportWidth) } : {}),
  };
}

export function describeRange(index: TextIndex, range: Range, viewportWidth?: number): TextAnchor | null {
  const start = offsetOfPoint(index, range.startContainer, range.startOffset);
  const end = offsetOfPoint(index, range.endContainer, range.endOffset);
  return describeSpan(index, start, end, viewportWidth);
}

/** Identifying text for an element: what a person would call it. */
export function labelOf(el: Element): string {
  const attr = (name: string) => normalizeText(el.getAttribute(name) ?? '');
  const alt = attr('alt') || attr('aria-label') || attr('title');
  if (alt) return alt.slice(0, 120);
  const svgTitle = el.tagName.toLowerCase() === 'svg' ? el.querySelector('title')?.textContent : null;
  if (svgTitle) return normalizeText(svgTitle).slice(0, 120);
  const src = el.getAttribute('src');
  if (src && !src.startsWith('data:')) {
    const file = src.split(/[?#]/)[0].split('/').pop();
    if (file) return file.slice(0, 120);
  }
  // As a person reads it: blocks separated by spaces, not run together.
  return buildTextIndex(el).text.slice(0, 80);
}

/** Elements a click should attach to as a whole: media and drawings, where a
 *  part (an SVG bar, a chart's canvas) has no stable identity of its own. */
const WHOLE_ELEMENT_TAGS = new Set(['svg', 'canvas', 'img', 'video', 'audio', 'picture', 'iframe', 'object', 'embed']);

export function pinTarget(el: Element): Element {
  let cur: Element | null = el;
  let best = el;
  while (cur && cur !== el.ownerDocument.body) {
    if (WHOLE_ELEMENT_TAGS.has(cur.tagName.toLowerCase())) best = cur;
    cur = cur.parentElement;
  }
  return best;
}

export function describeElement(
  el: Element,
  point: { x: number; y: number },
  viewportWidth?: number,
): ElementAnchor {
  const tag = el.tagName.toLowerCase();
  const doc = el.ownerDocument;
  const rect = el.getBoundingClientRect();
  const pct = (value: number, from: number, size: number) => (
    size > 0 ? Math.round(Math.max(0, Math.min(100, ((value - from) / size) * 100)) * 10) / 10 : 50
  );
  const sameTag = Array.from(doc.body?.getElementsByTagName(el.tagName) ?? []);
  const id = usableId(el);
  const lensId = usableLensId(el);
  const css = uniqueCssPath(el);
  const label = labelOf(el);
  const scope = describeScope(el, false);
  const section = sectionOf(el);
  return {
    v: 1,
    kind: 'element',
    tag,
    ...(id ? { id } : {}),
    ...(lensId ? { lensId } : {}),
    ...(css ? { css } : {}),
    ...(label ? { label } : {}),
    tagIndex: Math.max(0, sameTag.indexOf(el)),
    point: { x: pct(point.x, rect.left, rect.width), y: pct(point.y, rect.top, rect.height) },
    ...(scope ? { scope } : {}),
    ...(section ? { section } : {}),
    ...(viewportWidth ? { viewportWidth: Math.round(viewportWidth) } : {}),
  };
}

function nearestBlock(el: Element | null): Element | null {
  let cur = el;
  while (cur && !isBlockElement(cur)) cur = cur.parentElement;
  return cur;
}

interface SentenceSegmenter {
  segment(input: string): Iterable<{ segment: string; index: number }>;
}

function makeSegmenter(lang: string | undefined): SentenceSegmenter | null {
  const Segmenter = (Intl as unknown as { Segmenter?: new (lang?: string, opts?: { granularity: string }) => SentenceSegmenter }).Segmenter;
  if (!Segmenter) return null;
  try {
    return new Segmenter(lang || undefined, { granularity: 'sentence' });
  } catch {
    return new Segmenter(undefined, { granularity: 'sentence' });
  }
}

/** The span a click at index offset `at` comments on: the whole block when
 *  it is short (a heading, a list item, a button), else the sentence. */
export function clickSpan(index: TextIndex, at: number): { start: number; end: number } | null {
  if (at < 0 || at >= index.text.length) return null;
  const nodeIdx = index.nodeOf[at];
  if (nodeIdx < 0) return null;
  const block = nearestBlock(index.nodes[nodeIdx].parentElement);
  const span = block ? textSpanOf(index, block) : null;
  if (!span) return null;
  if (span.end - span.start <= WHOLE_BLOCK_CHARS) return span;
  const blockText = index.text.slice(span.start, span.end);
  const local = at - span.start;
  const segmenter = makeSegmenter(block?.ownerDocument.documentElement.lang);
  if (segmenter) {
    for (const { segment, index: segStart } of segmenter.segment(blockText)) {
      if (local >= segStart && local < segStart + segment.length) {
        return { start: span.start + segStart, end: span.start + segStart + segment.length };
      }
    }
  }
  // No Intl.Segmenter: split on sentence punctuation followed by a space.
  let from = 0;
  const re = /[.!?…](?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blockText)) !== null) {
    const stop = m.index + 1;
    if (local < stop) return { start: span.start + from, end: span.start + stop };
    from = stop;
  }
  return { start: span.start + from, end: span.end };
}

/** Whether `el` is inside the page's own content (not skipped, not ours). */
export function isPageContent(el: Element | null): boolean {
  for (let cur = el; cur; cur = cur.parentElement) {
    if (isSkippedElement(cur)) return false;
  }
  return !!el && !!el.ownerDocument.body?.contains(el);
}
