import { useState, useEffect, useCallback, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { StateEffect, Compartment } from '@codemirror/state';
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
 * Extract headings from CodeMirror editor state.
 * Iterates syntax tree to find ATXHeading nodes.
 */
export function extractHeadings(state: EditorState): Heading[] {
  const headings: Heading[] = [];
  const tree = syntaxTree(state);

  tree.iterate({
    enter(node) {
      const level = HEADING_TYPES[node.name];
      if (level !== undefined) {
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

        const text = state.doc.sliceString(textFrom, node.to).trim();
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
 * The warns below fire ONLY when that incomplete-parse condition is detected, so
 * they're silent in normal use but capture the rare failure in the wild.
 */
export function useHeadings(view: EditorView | null): Heading[] {
  // Called unconditionally (before the early return) to keep hook order stable.
  const diagRef = useRef<{ lastFullyParsed: boolean }>({ lastFullyParsed: true });
  if (!view) return [];

  const state = view.state;
  const headings = extractHeadings(state);

  const docLen = state.doc.length;
  const fullyParsed = syntaxTreeAvailable(state, docLen);

  if (!fullyParsed) {
    // ALWAYS-ON anomaly warn: the tree didn't cover the whole doc at extract time,
    // so the ToC is probably missing headings below the parsed boundary.
    const treeLen = syntaxTree(state).length;
    const groundTruth = countHeadingLikeLines(state);
    console.warn('[ToC] syntax tree incomplete at heading extraction', {
      docLength: docLen,
      treeParsedTo: treeLen,
      parsedFraction: docLen ? +(treeLen / docLen).toFixed(3) : 1,
      headingsExtracted: headings.length,
      headingLikeLinesInDoc: groundTruth,
      likelyMissing: Math.max(0, groundTruth - headings.length),
    });

    // SMOKING-GUN deferred re-check (observability only — logs, no state change,
    // no doc mutation, no forced parse): did parsing finish later while the ToC
    // stayed stale? extractHeadings here only reads view.state.
    setTimeout(() => {
      if (!view.dom.isConnected) return;
      const s2 = view.state;
      const nowFull = syntaxTreeAvailable(s2, s2.doc.length);
      const nowHeadings = extractHeadings(s2).length;
      console.warn('[ToC] deferred re-check after incomplete parse', {
        nowFullyParsed: nowFull,
        headingsNow: nowHeadings,
        headingsAtRenderTime: headings.length,
        gainedHeadings: nowHeadings - headings.length,
        note: 'if gainedHeadings > 0, the rendered ToC is stale (no re-render fired)',
      });
    }, 300);
  } else if (!diagRef.current.lastFullyParsed && import.meta.env.DEV) {
    console.info('[ToC] syntax tree now fully parsed on re-render', {
      headings: headings.length,
    });
  }

  diagRef.current.lastFullyParsed = fullyParsed;

  if (import.meta.env.DEV) {
    console.debug('[ToC] extract', {
      fullyParsed,
      headings: headings.length,
      docLength: docLen,
    });
  }

  return headings;
}

/**
 * Scroll to a heading position in the editor.
 */
export function scrollToHeading(view: EditorView, heading: Heading) {
  const scrollDOM = view.scrollDOM;
  scrollDOM.style.scrollBehavior = 'smooth';

  view.dispatch({
    selection: { anchor: heading.from },
    effects: [
      EditorView.scrollIntoView(heading.from, { y: 'center' }),
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
 * Hook that tracks which heading the cursor is under.
 * Finds the last heading at or before the cursor position.
 * Returns the index of the active heading (or -1 if none).
 */
export function useActiveHeading(view: EditorView | null, headings: Heading[]): number {
  const [activeIndex, setActiveIndex] = useState(-1);
  const compartmentRef = useRef<Compartment | null>(null);
  const installedRef = useRef(false);
  const installedViewRef = useRef<EditorView | null>(null);

  const updateActive = useCallback(() => {
    if (!view || headings.length === 0) {
      setActiveIndex(-1);
      return;
    }

    const cursorPos = view.state.selection.main.head;
    let active = -1;

    // Find the last heading at or before the cursor position
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].from <= cursorPos) {
        active = i;
      } else {
        break;
      }
    }

    // If cursor is before the first heading, highlight the first one
    if (active === -1 && headings.length > 0) {
      active = 0;
    }

    setActiveIndex(active);
  }, [view, headings]);

  useEffect(() => {
    if (!view) return;

    // Initial computation
    updateActive();

    const listener = EditorView.updateListener.of((update) => {
      if (update.selectionSet) {
        updateActive();
      }
    });

    if (!installedRef.current || installedViewRef.current !== view) {
      // First install or view changed: create compartment and append it
      const compartment = new Compartment();
      compartmentRef.current = compartment;
      installedViewRef.current = view;
      view.dispatch({ effects: StateEffect.appendConfig.of(compartment.of(listener)) });
      installedRef.current = true;
    } else if (compartmentRef.current) {
      // Subsequent updates (same view): reconfigure the compartment (replaces the listener)
      view.dispatch({ effects: compartmentRef.current.reconfigure(listener) });
    }
  }, [view, updateActive]);

  return activeIndex;
}
