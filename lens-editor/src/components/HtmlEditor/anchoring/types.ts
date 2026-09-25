/**
 * Anchors: what an HTML-page comment points at, described from the rendered
 * page (not the source), so a comment survives edits, reflow and scripts that
 * rebuild the DOM. Stored as plain JSON in the doc's `comments_v0` map and
 * re-resolved against the page on every render (see resolve.ts).
 *
 * Modelled on W3C Web Annotation selectors: a TextQuote (quote + prefix +
 * suffix) refined by an identifiable ancestor (scope), with a position hint
 * and an ordinal as last-resort tiebreakers for text that repeats verbatim.
 */

/** The nearest identifiable ancestor of the target. Narrows the search; a
 *  scope that no longer matches only lowers confidence, it never orphans. */
export interface ScopeSelector {
  /** Element id (skipped when it looks framework-generated). */
  id?: string;
  /** `data-lens-id`, the attribute the author guide asks for on repeated items. */
  lensId?: string;
  /** Shortest CSS path that was unique when the comment was made. */
  css?: string;
  tag: string;
}

export interface TextAnchor {
  v: 1;
  kind: 'text';
  /** Exact text, whitespace-collapsed as in the page's visible-text index. */
  quote: string;
  prefix: string;
  suffix: string;
  scope?: ScopeSelector;
  /** 0-based index among identical quote+context matches; only set when the
   *  context was not enough to tell them apart. */
  ordinal?: number;
  /** Offsets into the page's visible text when the comment was made. */
  position: { start: number; end: number; total: number };
  /** Nearest heading before the target, for people and agents reading a
   *  thread whose anchor is gone. */
  section?: string;
  viewportWidth?: number;
}

export interface ElementAnchor {
  v: 1;
  kind: 'element';
  tag: string;
  id?: string;
  lensId?: string;
  css?: string;
  /** Short identifying text: alt, aria-label, title, src file name or text. */
  label?: string;
  /** Index among elements with the same tag on the page. */
  tagIndex: number;
  /** Point inside the element's box, in % of its width and height. */
  point: { x: number; y: number };
  scope?: ScopeSelector;
  section?: string;
  viewportWidth?: number;
}

export type HtmlAnchor = TextAnchor | ElementAnchor;

/** anchored: found with confidence. guessed: found only by fuzzy match or a
 *  tiebreaker after the page changed; the UI asks someone to confirm.
 *  hidden: found, but not visible (collapsed section, inactive tab).
 *  orphaned: nothing on the page matches any more. */
export type AnchorState = 'anchored' | 'guessed' | 'hidden' | 'orphaned';

export const MAX_QUOTE_CHARS = 2000;
export const MAX_CONTEXT_CHARS = 200;
const MAX_SHORT_CHARS = 300;
const MAX_CSS_CHARS = 600;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= max) return value;
  // Never end on half of a surrogate pair.
  const cut = value.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function index(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && Number.isInteger(n) && n >= 0 && n < 1e7 ? n : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clean<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as Array<keyof T>) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function readScope(value: unknown): ScopeSelector | undefined {
  if (!isObject(value)) return undefined;
  const tag = str(value.tag, 40);
  if (!tag) return undefined;
  return clean({
    id: str(value.id, MAX_SHORT_CHARS),
    lensId: str(value.lensId, MAX_SHORT_CHARS),
    css: str(value.css, MAX_CSS_CHARS),
    tag,
  });
}

/** Parse an anchor from untrusted JSON (a page message, a Y.Map value written
 *  by another client or the relay). Returns null when it is not an anchor;
 *  clips every string so a page cannot bloat the shared doc. */
export function readAnchor(value: unknown): HtmlAnchor | null {
  if (!isObject(value)) return null;
  const section = str(value.section, MAX_SHORT_CHARS);
  const viewportWidth = num(value.viewportWidth);
  const scope = readScope(value.scope);
  if (value.kind === 'text') {
    const quote = str(value.quote, MAX_QUOTE_CHARS);
    if (!quote) return null;
    const pos = isObject(value.position) ? value.position : {};
    const start = index(pos.start) ?? 0;
    return clean({
      v: 1 as const,
      kind: 'text' as const,
      quote,
      prefix: str(value.prefix, MAX_CONTEXT_CHARS) ?? '',
      suffix: str(value.suffix, MAX_CONTEXT_CHARS) ?? '',
      scope,
      ordinal: index(value.ordinal),
      position: { start, end: index(pos.end) ?? start + quote.length, total: index(pos.total) ?? 0 },
      section,
      viewportWidth,
    });
  }
  if (value.kind === 'element') {
    const tag = str(value.tag, 40);
    if (!tag) return null;
    const point = isObject(value.point) ? value.point : {};
    const clampPct = (n: number | undefined) => Math.max(0, Math.min(100, n ?? 50));
    return clean({
      v: 1 as const,
      kind: 'element' as const,
      tag,
      id: str(value.id, MAX_SHORT_CHARS),
      lensId: str(value.lensId, MAX_SHORT_CHARS),
      css: str(value.css, MAX_CSS_CHARS),
      label: str(value.label, MAX_SHORT_CHARS),
      tagIndex: index(value.tagIndex) ?? 0,
      point: { x: clampPct(num(point.x)), y: clampPct(num(point.y)) },
      scope,
      section,
      viewportWidth,
    });
  }
  return null;
}

const ELEMENT_NAMES: Record<string, string> = {
  img: 'Image', picture: 'Image', svg: 'Drawing', canvas: 'Chart', video: 'Video', audio: 'Audio',
  button: 'Button', a: 'Link', input: 'Input field', select: 'Dropdown', textarea: 'Text box',
  label: 'Label', table: 'Table', tr: 'Table row', td: 'Table cell', th: 'Table header', li: 'List item',
  ul: 'List', ol: 'List', h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading',
  h6: 'Heading', p: 'Paragraph', figure: 'Figure', form: 'Form', nav: 'Navigation', summary: 'Toggle',
};

/** One-line description of what an anchor points at, in words a reader
 *  uses: the quote, or e.g. `Button “Choose plan”`. */
export function describeAnchorTarget(anchor: HtmlAnchor): string {
  if (anchor.kind === 'text') return anchor.quote;
  const name = ELEMENT_NAMES[anchor.tag] ?? 'Element';
  return anchor.label ? `${name} “${anchor.label}”` : name;
}
