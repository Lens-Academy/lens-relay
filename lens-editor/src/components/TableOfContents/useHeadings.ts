import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
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

/**
 * Scroll to a heading position in the editor: the heading near the top of
 * the page, as Notion's table of contents scrolls.
 */
export function scrollToHeading(view: EditorView, heading: Heading) {
  const scrollDOM = view.scrollDOM;
  scrollDOM.style.scrollBehavior = 'smooth';

  view.dispatch({
    selection: { anchor: heading.from },
    effects: [
      EditorView.scrollIntoView(heading.from, { y: 'start', yMargin: 48 }),
      flashHeadingLine.of(heading.from),
    ],
  });

  setTimeout(() => {
    scrollDOM.style.scrollBehavior = '';
  }, 300);

  view.focus();
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
