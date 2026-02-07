import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

export interface Heading {
  level: number;  // 1-6
  text: string;
  from: number;   // Position in document
  to: number;
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
