/**
 * Find an anchor again in the page as it is now.
 *
 * Text anchors, in order: the exact quote with its context (narrowed by the
 * scope, then the ordinal, for verbatim repeats) → the exact quote alone when
 * it is distinctive → a fuzzy match of the quote near where it used to be →
 * the gap between the surviving prefix and suffix. Anything that was not
 * found with confidence is `guessed`, never silently moved; nothing found is
 * `orphaned`.
 */
import { FUZZY_MAX_PATTERN, fuzzyFind, similarity } from './fuzzy';
import { labelOf, occurrences, describeSpan } from './describe';
import { textSpanOf, type TextIndex } from './text-index';
import type { ElementAnchor, HtmlAnchor, ScopeSelector, TextAnchor } from './types';

export type ResolvedState = 'anchored' | 'guessed' | 'orphaned';

export interface TextResolution {
  kind: 'text';
  state: ResolvedState;
  start: number;
  end: number;
  /** The stored anchor no longer describes the text exactly (context or
   *  quote changed) although it was found with confidence: a fresh anchor
   *  keeps the next edit's matching easy. */
  drifted: boolean;
  /** How much of the stored context surrounds the match, in [0, 1]. Drifted
   *  anchors are only rewritten when this is high. */
  context: number;
}

export interface ElementResolution {
  kind: 'element';
  state: ResolvedState;
  element: Element;
  drifted: boolean;
}

export type Resolution = TextResolution | ElementResolution | { kind: 'none'; state: 'orphaned' };

const ORPHAN = { kind: 'none', state: 'orphaned' } as const;
/** A verbatim quote this long that occurs once is the same passage even if
 *  everything around it changed (it was moved). */
const SELF_EVIDENT_QUOTE_CHARS = 40;
/** Medium-length unique quotes need some of their context too. */
const MEDIUM_QUOTE_CHARS = 25;
const FUZZY_WINDOW = 2000;

function cssEscape(doc: Document, value: string): string {
  const css = (doc.defaultView as (Window & { CSS?: { escape?: (v: string) => string } }) | null)?.CSS;
  return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

function query(doc: Document, selector: string): Element[] {
  try {
    return Array.from(doc.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** The scope's element now. `strong` when found by an author-given identity
 *  (id, data-lens-id), which outranks the quote's context; a CSS path only
 *  breaks ties. */
export function resolveScopeElement(
  doc: Document,
  scope: ScopeSelector | undefined,
): { element: Element; strong: boolean } | null {
  if (!scope) return null;
  const matchesTag = (el: Element | null) => el && el.tagName.toLowerCase() === scope.tag ? el : null;
  if (scope.id) {
    const el = matchesTag(doc.getElementById(scope.id));
    if (el) return { element: el, strong: true };
  }
  if (scope.lensId) {
    const els = query(doc, `[data-lens-id="${cssEscape(doc, scope.lensId)}"]`);
    if (els.length === 1 && matchesTag(els[0])) return { element: els[0], strong: true };
  }
  if (scope.css) {
    const els = query(doc, scope.css);
    if (els.length === 1 && matchesTag(els[0])) return { element: els[0], strong: false };
  }
  return null;
}

/** Characters of `expected` that match going backwards from `at`, as a fraction. */
/** How much of the stored prefix still precedes `at`, in [0, 1]: the exact
 *  run of matching characters, or (when `refine`) the similarity of edited
 *  context. Refining costs O(prefix²), so it is skipped for common quotes. */
function prefixScore(text: string, at: number, prefix: string, refine: boolean): number {
  if (!prefix) return 1;
  let n = 0;
  while (n < prefix.length && at - 1 - n >= 0 && text[at - 1 - n] === prefix[prefix.length - 1 - n]) n++;
  if (n === prefix.length) return 1;
  if (!refine) return n / prefix.length;
  const actual = text.slice(Math.max(0, at - prefix.length), at);
  return Math.max(n / prefix.length, similarity(actual, prefix) * 0.9);
}

function suffixScore(text: string, at: number, suffix: string, refine: boolean): number {
  if (!suffix) return 1;
  let n = 0;
  while (n < suffix.length && at + n < text.length && text[at + n] === suffix[n]) n++;
  if (n === suffix.length) return 1;
  if (!refine) return n / suffix.length;
  const actual = text.slice(at, at + suffix.length);
  return Math.max(n / suffix.length, similarity(actual, suffix) * 0.9);
}

function expectedStart(anchor: TextAnchor, total: number): number {
  const { start, total: then } = anchor.position;
  return then > 0 ? Math.round((start / then) * total) : start;
}

interface Candidate {
  start: number;
  context: number;
  inScope: boolean;
  proximity: number;
}

export function resolveTextAnchor(doc: Document, index: TextIndex, anchor: TextAnchor): TextResolution | typeof ORPHAN {
  const text = index.text;
  const quote = anchor.quote;
  const total = text.length;
  if (!quote || total === 0) return ORPHAN;
  const expected = expectedStart(anchor, total);
  const scope = resolveScopeElement(doc, anchor.scope);
  const scopeSpan = scope ? textSpanOf(index, scope.element) : null;
  const unchangedPage = total === anchor.position.total;

  const found = occurrences(text, quote);
  if (found.length > 0) {
    const refine = found.length <= 50;
    const candidates: Candidate[] = found.map(start => ({
      start,
      context: (prefixScore(text, start, anchor.prefix, refine)
        + suffixScore(text, start + quote.length, anchor.suffix, refine)) / 2,
      inScope: !!scopeSpan && start >= scopeSpan.start && start + quote.length <= scopeSpan.end,
      proximity: 1 - Math.min(1, Math.abs(start - expected) / Math.max(1, total)),
    }));
    const result = (start: number, state: ResolvedState, drifted: boolean, context: number): TextResolution => ({
      kind: 'text', state, start, end: start + quote.length, drifted, context,
    });

    // An author-given identity (id, data-lens-id) around the quote outranks
    // its context: matches inside it are the only candidates, and when it no
    // longer holds the quote nothing elsewhere is more than a guess.
    let pool = candidates;
    let cap: ResolvedState = 'anchored';
    let scopedIn = false;
    if (scope?.strong) {
      const scoped = candidates.filter(c => c.inScope);
      if (scoped.length > 0) {
        pool = scoped;
        scopedIn = true;
      } else {
        cap = 'guessed';
      }
    }
    const capped = (state: ResolvedState): ResolvedState => (cap === 'guessed' ? 'guessed' : state);

    const full = pool.filter(c => c.context === 1);
    if (full.length === 1) return result(full[0].start, capped('anchored'), false, 1);
    if (full.length > 1) {
      // Only a CSS path (positional, like the ordinal) tells these apart, so
      // it is trusted only while the page is unchanged.
      const inScope = full.filter(c => c.inScope);
      if (inScope.length === 1) return result(inScope[0].start, capped(unchangedPage ? 'anchored' : 'guessed'), false, 1);
      const choices = inScope.length > 1 ? inScope : full;
      const ordinal = anchor.ordinal;
      const pick = ordinal !== undefined && Number.isInteger(ordinal) && ordinal >= 0 && ordinal < full.length
        ? full[ordinal]
        : choices.reduce((x, y) => (y.proximity > x.proximity ? y : x));
      const exact = unchangedPage && pick.start === anchor.position.start;
      return result(pick.start, capped(exact ? 'anchored' : 'guessed'), false, 1);
    }

    // The quote is still there but its surroundings changed: it was edited
    // around, moved, or this is a different copy of the same words. Trust it
    // only with evidence beyond the words themselves.
    const score = (c: Candidate) => c.context + (c.inScope ? 0.3 : 0) + c.proximity * 0.1;
    const ranked = [...pool].sort((x, y) => score(y) - score(x));
    const best = ranked[0];
    const unique = pool.length === 1;
    const margin = ranked.length > 1 ? score(best) - score(ranked[1]) : 1;
    const evidence = unique
      ? quote.length >= SELF_EVIDENT_QUOTE_CHARS
        || best.context >= 0.5
        || (best.context >= 0.3 && (scopedIn || quote.length >= MEDIUM_QUOTE_CHARS))
      : best.context >= 0.5 && margin >= 0.2 && quote.length >= 8;
    if (!evidence && best.context < 0.5) {
      // The same words elsewhere, out of context, versus a slightly edited
      // quote still in its old surroundings (a typo in "a full" while "a
      // full" also appears further down): the surroundings win.
      const between = betweenContext(text, anchor, expected);
      if (between) {
        const same = similarity(text.slice(between.start, between.end), quote);
        if (same >= 0.5) {
          return { kind: 'text', state: capped(same >= 0.75 ? 'anchored' : 'guessed'), ...between, drifted: true, context: 1 };
        }
      }
    }
    return result(best.start, capped(evidence ? 'anchored' : 'guessed'), true, best.context);
  }

  return fuzzyResolve(text, anchor, expected);
}

function contextSimilarity(text: string, start: number, end: number, anchor: TextAnchor): number {
  const pre = anchor.prefix ? similarity(text.slice(Math.max(0, start - anchor.prefix.length), start), anchor.prefix) : 1;
  const suf = anchor.suffix ? similarity(text.slice(end, end + anchor.suffix.length), anchor.suffix) : 1;
  return Math.max(pre, suf);
}

/** Fuzzy search near the expected position first, then the whole page. */
function nearFirst(text: string, pattern: string, maxErrors: number, expected: number, from = 0, to = text.length) {
  const near = fuzzyFind(text, pattern, maxErrors, {
    from: Math.max(from, expected - FUZZY_WINDOW),
    to: Math.min(to, expected + pattern.length + FUZZY_WINDOW),
    expected,
  });
  if (near) return { ...near, near: true };
  const anywhere = fuzzyFind(text, pattern, maxErrors, { from, to, expected });
  return anywhere ? { ...anywhere, near: false } : null;
}

/** The stored context still sits right next to [start, end): the strongest
 *  sign a fuzzy match is the same passage and not a look-alike elsewhere. */
function contextAdjacent(text: string, start: number, end: number, anchor: TextAnchor): { before: boolean; after: boolean } {
  const pre = anchor.prefix.slice(-16);
  const suf = anchor.suffix.slice(0, 16);
  const before = pre.length >= 4 && similarity(text.slice(Math.max(0, start - pre.length), start), pre) >= 0.75;
  const after = suf.length >= 4 && similarity(text.slice(end, end + suf.length), suf) >= 0.75;
  return { before, after };
}

function fuzzyResolve(text: string, anchor: TextAnchor, expected: number): TextResolution | typeof ORPHAN {
  const quote = anchor.quote;
  const length = quote.length;
  const found = (start: number, end: number, state: ResolvedState): TextResolution => ({
    kind: 'text', state, start, end, drifted: true, context: contextSimilarity(text, start, end, anchor),
  });

  if (length >= 5 && length <= FUZZY_MAX_PATTERN) {
    const match = nearFirst(text, quote, Math.max(1, Math.floor(length * 0.25)), expected);
    if (match) {
      const ctx = contextAdjacent(text, match.start, match.end, anchor);
      const small = match.errors <= Math.max(1, Math.floor(length * 0.1));
      // A small edit inside a quote whose surroundings still match is the same
      // passage: a fixed typo, a changed word.
      if (small && contextSimilarity(text, match.start, match.end, anchor) >= 0.8) return found(match.start, match.end, 'anchored');
      // Larger differences need corroboration: found where it used to be, or
      // with its old surroundings.
      if (match.near || ctx.before || ctx.after) return found(match.start, match.end, 'guessed');
    }
  } else if (length > FUZZY_MAX_PATTERN) {
    const edge = 32;
    const maxErrors = 6;
    const head = nearFirst(text, quote.slice(0, edge), maxErrors, expected);
    const tailFrom = head ? head.start : 0;
    const tail = nearFirst(text, quote.slice(-edge), maxErrors, expected + length - edge, tailFrom,
      head ? Math.min(text.length, head.start + Math.ceil(length * 1.6) + edge) : text.length);
    if (head && tail && tail.end > head.start) {
      const span = tail.end - head.start;
      if (span >= length * 0.5 && span <= length * 1.6) {
        const sameText = similarity(text.slice(head.start, tail.end), quote) >= 0.85;
        return found(head.start, tail.end, sameText ? 'anchored' : 'guessed');
      }
    }
    // One surviving edge is only trusted with its old neighbour beside it.
    if (head) {
      const end = Math.min(text.length, head.start + length);
      if (contextAdjacent(text, head.start, end, anchor).before) return found(head.start, end, 'guessed');
    }
    if (tail) {
      const start = Math.max(0, tail.end - length);
      if (contextAdjacent(text, start, tail.end, anchor).after) return found(start, tail.end, 'guessed');
    }
  }

  // The quote itself was rewritten: what lies between its old surroundings.
  const between = betweenContext(text, anchor, expected);
  return between ? found(between.start, between.end, 'guessed') : ORPHAN;
}

/** The text between the anchor's old prefix and suffix, when both survive
 *  close together (nearest the expected position). Null when they are gone,
 *  far apart, or adjacent (the passage was deleted, not rewritten). */
function betweenContext(text: string, anchor: TextAnchor, expected: number): { start: number; end: number } | null {
  const length = anchor.quote.length;
  const pre = anchor.prefix.slice(-24);
  const suf = anchor.suffix.slice(0, 24);
  if (pre.length < 8 || suf.length < 8) return null;
  let best: { start: number; end: number; distance: number } | null = null;
  for (const p of occurrences(text, pre, 50)) {
    const from = p + pre.length;
    const s = text.indexOf(suf, from);
    if (s < 0 || s - from > length * 3 + 200) continue;
    const distance = Math.abs(from - expected);
    if (!best || distance < best.distance) best = { start: from, end: s, distance };
  }
  if (!best) return null;
  let { start, end } = best;
  while (start < end && text[start] === ' ') start++;
  while (end > start && text[end - 1] === ' ') end--;
  return end - start >= Math.min(3, length) ? { start, end } : null;
}

export function resolveElementAnchor(doc: Document, anchor: ElementAnchor): ElementResolution | typeof ORPHAN {
  const tagMatches = (el: Element | null | undefined): el is Element => !!el && el.tagName.toLowerCase() === anchor.tag;
  const labelMatches = (el: Element) => !anchor.label || labelOf(el) === anchor.label;
  const result = (element: Element, state: ResolvedState): ElementResolution => ({
    kind: 'element', state, element, drifted: state === 'anchored' && !labelMatches(element),
  });

  if (anchor.id) {
    const el = doc.getElementById(anchor.id);
    if (tagMatches(el)) return result(el, 'anchored');
  }
  if (anchor.lensId) {
    const els = query(doc, `[data-lens-id="${cssEscape(doc, anchor.lensId)}"]`).filter(tagMatches);
    if (els.length === 1) return result(els[0], 'anchored');
  }
  const sameTag = Array.from(doc.body?.getElementsByTagName(anchor.tag) ?? []);
  const byCss = anchor.css ? query(doc, anchor.css).filter(tagMatches) : [];
  const cssHit = byCss.length === 1 ? byCss[0] : null;
  if (cssHit && anchor.label && labelMatches(cssHit)) return result(cssHit, 'anchored');
  if (cssHit && !anchor.label) {
    // A positional path alone (canvases, unlabelled drawings) is trusted
    // only when nothing else could be meant: the one element of its kind,
    // or still at the same index among them.
    const sure = sameTag.length === 1 || sameTag.indexOf(cssHit) === anchor.tagIndex;
    return result(cssHit, sure ? 'anchored' : 'guessed');
  }

  if (anchor.label) {
    const labelled = sameTag.filter(el => labelOf(el) === anchor.label);
    if (labelled.length === 1) return result(labelled[0], 'anchored');
    if (labelled.length > 1) {
      const closest = labelled.reduce((a, b) => (
        Math.abs(sameTag.indexOf(b) - anchor.tagIndex) < Math.abs(sameTag.indexOf(a) - anchor.tagIndex) ? b : a
      ));
      return result(closest, sameTag.indexOf(closest) === anchor.tagIndex ? 'anchored' : 'guessed');
    }
  }
  if (cssHit) return result(cssHit, 'guessed');
  const byIndex = sameTag[anchor.tagIndex];
  if (byIndex) return result(byIndex, 'guessed');
  return ORPHAN;
}

export function resolveAnchor(doc: Document, index: TextIndex, anchor: HtmlAnchor): Resolution {
  return anchor.kind === 'text' ? resolveTextAnchor(doc, index, anchor) : resolveElementAnchor(doc, anchor);
}

/** A fresh anchor for where a drifted text anchor was found, keeping the
 *  scope description current. */
export function refreshTextAnchor(index: TextIndex, resolution: TextResolution, viewportWidth?: number): TextAnchor | null {
  return describeSpan(index, resolution.start, resolution.end, viewportWidth);
}
