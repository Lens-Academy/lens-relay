import { useState, useEffect, useCallback } from 'react';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { StateEffect } from '@codemirror/state';
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
 * Hook to get headings from an EditorView.
 * Computes headings from current state on each call.
 * Parent should trigger re-render when document changes (via stateVersion prop).
 */
export function useHeadings(view: EditorView | null): Heading[] {
  if (!view) return [];
  return extractHeadings(view.state);
}

/**
 * Scroll to a heading position in the editor.
 */
export function scrollToHeading(view: EditorView, heading: Heading) {
  view.dispatch({
    selection: { anchor: heading.from },
    scrollIntoView: true,
  });
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

    // Listen for selection/cursor changes via EditorView update listener
    const extension = EditorView.updateListener.of((update) => {
      if (update.selectionSet) {
        updateActive();
      }
    });

    // Dispatch a reconfigure to add the listener
    view.dispatch({ effects: StateEffect.appendConfig.of(extension) });

    // No clean way to remove a dynamically added extension, but the effect
    // is idempotent (setActiveIndex with same value is a no-op)
  }, [view, updateActive]);

  return activeIndex;
}
