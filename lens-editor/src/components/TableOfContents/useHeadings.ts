import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { forceParsing, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { flashHeadingLine } from '../Editor/extensions/headingFlash';
import type { EditorState } from '@codemirror/state';

export interface Heading {
  level: number;  // 1-6
  text: string;
  from: number;   // Position in document
  to: number;
}

export interface NormalizedHeading extends Heading {
  displayLevel: number;  // Normalized level for visual hierarchy
}

const HEADING_TYPES: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
};

/**
 * A heading's text as it reads: without its markdown (emphasis, code, links
 * and wikilinks, highlights and suggestions)
 */
export function plainHeadingText(text: string): string {
  return text
    .replace(/\{>>[\s\S]*?<<\}|\{--[\s\S]*?--\}/g, '')
    .replace(/\{~~[\s\S]*?~>([\s\S]*?)~~\}/g, '$1')
    .replace(/\{(\+\+|==)([\s\S]*?)(\+\+|==)\}/g, '$2')
    .replace(/!?\[\[([^\]|]*?)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) => alias ?? target.split('/').pop()!.replace(/#.*/, ''))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==|`)/g, '')
    .replace(/(^|\W)[*_](?=\S)(.+?)(?<=\S)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract headings from CodeMirror editor state: the page's own ATX
 * headings, not those inside lists or quotes (a "- ##### Label" item), as
 * Notion's table of contents lists its heading blocks.
 */
export function extractHeadings(state: EditorState): Heading[] {
  const headings: Heading[] = [];
  const tree = syntaxTree(state);

  tree.iterate({
    enter(node) {
      const level = HEADING_TYPES[node.name];
      if (level !== undefined && node.node.parent?.name === 'Document') {
        // Skip HeaderMark (# characters) to get just the text
        let textFrom = node.from;

        // Find HeaderMark child to skip it
        const cursor = node.node.cursor();
        if (cursor.firstChild()) {
          do {
            if (cursor.name === 'HeaderMark') {
              textFrom = cursor.to;
              // Skip trailing space after #
              while (textFrom < node.to &&
                     state.doc.sliceString(textFrom, textFrom + 1) === ' ') {
                textFrom++;
              }
              break;
            }
          } while (cursor.nextSibling());
        }

        const text = plainHeadingText(state.doc.sliceString(textFrom, node.to));
        if (text) {
          headings.push({
            level,
            text,
            from: node.from,
            to: node.to,
          });
        }
      }
    },
  });

  return headings;
}

/**
 * Cheap, independent ground-truth count of heading-like lines, read directly from
 * the document text rather than the syntax tree. Used only as a diagnostic
 * cross-check when an incomplete-parse anomaly is already suspected, so it never
 * runs on the hot path.
 *
 * Caveat: this can overcount `#` lines that live inside fenced code blocks (those
 * are not real headings), so it is a signal, not an exact count. A large gap
 * between this and the tree-extracted count is still strong evidence that the
 * syntax tree was incomplete at extraction time.
 */
function countHeadingLikeLines(state: EditorState): number {
  let count = 0;
  const doc = state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    if (/^#{1,6}\s/.test(doc.line(i).text)) count++;
  }
  return count;
}

/**
 * Hook to get headings from an EditorView.
 * Computes headings from current state on each call.
 * Parent should trigger re-render when document changes (via stateVersion prop).
 *
 * Observability: the ToC reads CodeMirror's lazily/incrementally parsed syntax
 * tree. If the tree isn't parsed all the way to the end of the document at extract
 * time, headings below the parsed boundary are silently missing — and because a
 * background parse completing does NOT trigger a React re-render, the ToC can stay
 * stale until some unrelated re-render (e.g. clicking a heading) re-runs extraction.
 * The diagnostic logging below lives in a commit-phase effect (never in render) and
 * fires ONLY when that incomplete-parse condition is detected, so it's silent in
 * normal use but captures the rare failure in the wild.
 */
export function useHeadings(view: EditorView | null): Heading[] {
  // All hooks run unconditionally (no early return) to keep hook order stable.
  const diagRef = useRef<{ lastFullyParsed: boolean }>({ lastFullyParsed: true });

  // Pure render-phase reads only — extraction has no side effects.
  const headings = view ? extractHeadings(view.state) : [];
  const docLen = view ? view.state.doc.length : 0;
  const fullyParsed = view ? syntaxTreeAvailable(view.state, docLen) : true;
  const headingCount = headings.length;

  // Side-effecting observability runs in the commit phase, so it doesn't fire
  // twice under Strict Mode's double-render and any deferred timer is cleaned up.
  useEffect(() => {
    if (!view) return;

    const wasFullyParsed = diagRef.current.lastFullyParsed;
    diagRef.current.lastFullyParsed = fullyParsed;

    if (fullyParsed) {
      if (!wasFullyParsed && import.meta.env.DEV) {
        console.info('[ToC] syntax tree now fully parsed on re-render', {
          headings: headingCount,
        });
      }
      if (import.meta.env.DEV) {
        console.debug('[ToC] extract', { fullyParsed, headings: headingCount, docLength: docLen });
      }
      return;
    }

    // Anomaly: the tree didn't cover the whole doc at extract time, so the ToC is
    // probably missing headings below the parsed boundary. Warn once per episode
    // (on the fully-parsed -> incomplete transition) rather than on every render,
    // to keep production logs readable.
    if (wasFullyParsed) {
      const state = view.state;
      const treeLen = syntaxTree(state).length;
      const groundTruth = countHeadingLikeLines(state);
      console.warn('[ToC] syntax tree incomplete at heading extraction', {
        docLength: docLen,
        treeParsedTo: treeLen,
        parsedFraction: docLen ? +(treeLen / docLen).toFixed(3) : 1,
        headingsExtracted: headingCount,
        headingLikeLinesInDoc: groundTruth,
        likelyMissing: Math.max(0, groundTruth - headingCount),
      });
    }

    // SMOKING-GUN deferred re-check (observability only — logs, no state change,
    // no doc mutation, no forced parse): did parsing finish later while the ToC
    // stayed stale? extractHeadings here only reads view.state. Cleared on the next
    // effect run or unmount so timers never stack across renders.
    const timer = setTimeout(() => {
      if (!view.dom.isConnected) return;
      const s2 = view.state;
      const nowFull = syntaxTreeAvailable(s2, s2.doc.length);
      const nowHeadings = extractHeadings(s2).length;
      console.warn('[ToC] deferred re-check after incomplete parse', {
        nowFullyParsed: nowFull,
        headingsNow: nowHeadings,
        headingsAtRenderTime: headingCount,
        gainedHeadings: nowHeadings - headingCount,
        note: 'if gainedHeadings > 0, the rendered ToC is stale (no re-render fired)',
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [view, fullyParsed, headingCount, docLen]);

  return headings;
}

/** Where a heading goes when picked: this far below the top of the page */
const HEADING_TOP_MARGIN = 48;

/**
 * How long the heading is held in place after the glide: what was drawn on
 * the way (images, tables, embeds) can change size as it loads, which would
 * otherwise carry the heading off
 */
const HOLD_MS = 1200;

/** A glide still under way, by editor, so a new pick or the reader's own scroll stops it */
const glides = new WeakMap<EditorView, () => void>();

/**
 * The scrollTop that puts `pos` HEADING_TOP_MARGIN below the top of the page,
 * from where CodeMirror places it now. Lines far off screen are placed by an
 * estimate that firms up as they are drawn, so this is asked again each frame.
 */
function headingScrollTop(view: EditorView, pos: number, clamp = true): number {
  const scroller = view.scrollDOM;
  const top = view.documentTop + view.lineBlockAt(pos).top - scroller.getBoundingClientRect().top;
  const max = scroller.scrollHeight - scroller.clientHeight;
  const goal = scroller.scrollTop + top - HEADING_TOP_MARGIN;
  return clamp ? Math.max(0, Math.min(max, goal)) : goal;
}

/**
 * Glide the page to `pos` in about 0.25-0.5s, aiming each frame at where the
 * heading is now, then hold it there while what is around it is measured and
 * loads. Not the browser's smooth scroll: CodeMirror corrects scrollTop as it
 * measures lines, which stopped a smooth scroll short, most of all going up
 * the page. The reader scrolling, clicking or typing takes over.
 */
function glideTo(view: EditorView, pos: number) {
  glides.get(view)?.();
  const scroller = view.scrollDOM;
  const from = scroller.scrollTop;
  const distance = Math.abs(headingScrollTop(view, pos) - from);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const duration = reduced ? 0 : Math.min(500, 250 + distance / 8);
  const start = performance.now();
  let frame = 0;
  let rescued = false;

  const takeover = ['wheel', 'touchstart', 'mousedown', 'keydown'] as const;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const type of takeover) scroller.removeEventListener(type, stop);
    if (glides.get(view) === stop) glides.delete(view);
  };
  for (const type of takeover) scroller.addEventListener(type, stop, { passive: true });
  glides.set(view, stop);

  const step = (now: number) => {
    const t = duration > 0 ? Math.min(1, (now - start) / duration) : 1;
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const goal = headingScrollTop(view, pos);
    if (t < 1) {
      scroller.scrollTop = from + (goal - from) * eased;
    } else {
      // There: hold the heading in place, measuring each frame, as the page
      // may be taller than estimated (the glide can reach the estimated
      // bottom with the heading still below) and what loads may move it
      view.requestMeasure();
      // The page drawn shorter than CodeMirror's own measure of it (it can
      // give up measuring around lines it hides, such as a long comment's),
      // so the heading is out of reach: CodeMirror's own scroll draws the
      // region it goes to first. Once.
      if (!rescued && headingScrollTop(view, pos, false) > scroller.scrollHeight - scroller.clientHeight + 2) {
        rescued = true;
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: HEADING_TOP_MARGIN }) });
      } else if (Math.abs(scroller.scrollTop - goal) > 1) {
        scroller.scrollTop = goal;
      }
      if (now - start > duration + HOLD_MS) {
        stop();
        return;
      }
    }
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

/**
 * Scroll to a heading position in the editor: the heading near the top of
 * the page, as Notion's table of contents scrolls. The heading is found again
 * in the page as it is now (by its level and text, the nearest to where it
 * was), in case the page changed since the outline was drawn.
 */
export function scrollToHeading(view: EditorView, heading: Heading) {
  const now = extractHeadings(view.state)
    .filter((h) => h.level === heading.level && h.text === heading.text)
    .sort((a, b) => Math.abs(a.from - heading.from) - Math.abs(b.from - heading.from))[0];
  const pos = Math.min(now?.from ?? heading.from, view.state.doc.length);
  // Parsed to past the heading first: lines still unparsed get their heading
  // sizes later, and the heading would move after the glide
  forceParsing(view, Math.min(view.state.doc.length, pos + 2000), 200);

  view.dispatch({
    selection: { anchor: pos },
    effects: flashHeadingLine.of(pos),
  });
  view.focus();
  glideTo(view, pos);
}

/**
 * Normalize heading levels using a stack-based algorithm (Obsidian-style).
 * Maps raw markdown levels to display levels so a document starting with ###
 * renders that as level 1 instead of wasting two indentation levels.
 *
 * Algorithm: for each heading, pop stack entries with rawLevel >= current,
 * then displayLevel = stack.top.displayLevel + 1 (or 1 if empty).
 */
export function normalizeHeadingLevels(headings: Heading[]): NormalizedHeading[] {
  const stack: { rawLevel: number; displayLevel: number }[] = [];

  return headings.map((heading) => {
    // Pop entries with rawLevel >= current heading's level
    while (stack.length > 0 && stack[stack.length - 1].rawLevel >= heading.level) {
      stack.pop();
    }

    const displayLevel = stack.length > 0
      ? stack[stack.length - 1].displayLevel + 1
      : 1;

    stack.push({ rawLevel: heading.level, displayLevel });

    return { ...heading, displayLevel };
  });
}

/**
 * Levels by heading type: the page's highest heading level is 1, the next 2,
 * and so on, so every H3 on a page looks alike (the page outline's dashes),
 * whatever heading it follows.
 */
export function rankHeadingLevels(headings: Heading[]): NormalizedHeading[] {
  const top = Math.min(...headings.map((heading) => heading.level));
  return headings.map((heading) => ({ ...heading, displayLevel: heading.level - top + 1 }));
}

/**
 * The heading of the section being read: the last one whose top is at or
 * above `probe` (a line near the top of the page), else the first. `tops`
 * are the headings' tops, in the same coordinates as `probe`.
 */
export function headingInView(tops: number[], probe: number): number {
  let active = tops.length > 0 ? 0 : -1;
  tops.forEach((top, i) => {
    if (top <= probe) active = i;
  });
  return active;
}

/**
 * The index of the heading whose section is in view, which Notion's table
 * of contents marks: it follows scrolling, and edits that move the
 * headings. It only reads the layout. Dispatching here (a cursor listener
 * did) made CodeMirror lose its scroll anchor, so text added above the
 * viewport pushed the page down.
 */
export function useHeadingInView(view: EditorView | null, headings: Heading[]): number {
  const [active, setActive] = useState(-1);
  const headingsRef = useRef(headings);
  useLayoutEffect(() => {
    headingsRef.current = headings;
  });
  const positions = headings.map((h) => h.from).join(',');

  useEffect(() => {
    if (!view) return;
    const scroller = view.scrollDOM;
    let frame = 0;
    const update = () => {
      frame = 0;
      const list = headingsRef.current;
      if (list.length === 0 || !view.dom.isConnected) {
        setActive(-1);
        return;
      }
      const rect = scroller.getBoundingClientRect();
      // A quarter of the way down the page; at the end of the page, its
      // bottom, so the last sections can be marked too
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      const probe = atEnd ? rect.bottom : rect.top + scroller.clientHeight / 4;
      const docTop = view.documentTop;
      const end = view.state.doc.length;
      setActive(headingInView(list.map((h) => docTop + view.lineBlockAt(Math.min(h.from, end)).top), probe));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    schedule();
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [view, positions]);

  return active;
}
