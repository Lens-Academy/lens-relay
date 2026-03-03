/**
 * Inline Formatting Shortcuts (Ctrl+B, Ctrl+I, etc.)
 *
 * A single toggleInlineFormat(marker) factory that returns a StateCommand.
 * All inline formatting shortcuts share the same wrap/unwrap logic —
 * only the marker string differs.
 */
import type { StateCommand } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';

const MARKER_CHAR = /[*_~`=]/;

/** Check if an unwrap would be ambiguous (markers belong to a longer format). */
function isAmbiguousUnwrap(doc: string, markerStart: number, markerEnd: number, marker: string): boolean {
  const ch = marker[0];
  if (!MARKER_CHAR.test(ch)) return false;
  // Check char just outside the markers
  const charBefore = markerStart > 0 ? doc[markerStart - 1] : '';
  const charAfter = markerEnd < doc.length ? doc[markerEnd] : '';
  return charBefore === ch || charAfter === ch;
}

/**
 * Factory: creates a StateCommand that toggles inline formatting markers.
 */
export function toggleInlineFormat(marker: string): StateCommand {
  const len = marker.length;

  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
      const doc = state.doc.toString();

      if (!range.empty) {
        // Check if selection is already wrapped with markers
        const before = state.sliceDoc(range.from - len, range.from);
        const after = state.sliceDoc(range.to, range.to + len);
        if (before === marker && after === marker &&
            !isAmbiguousUnwrap(doc, range.from - len, range.to + len, marker)) {
          // Unwrap: remove markers around selection
          return {
            range: EditorSelection.range(range.from - len, range.to - len),
            changes: [
              { from: range.from - len, to: range.from, insert: '' },
              { from: range.to, to: range.to + len, insert: '' },
            ],
          };
        }

        // Wrap with markers
        const insert = marker + state.sliceDoc(range.from, range.to) + marker;
        return {
          range: EditorSelection.range(range.from + len, range.to + len),
          changes: { from: range.from, to: range.to, insert },
        };
      }

      // Cursor only: expand to word boundaries
      const pos = range.head;
      const line = state.doc.lineAt(pos);
      const lineText = line.text;
      const offset = pos - line.from;

      // Scan left/right for word characters
      let wordStart = offset;
      let wordEnd = offset;
      while (wordStart > 0 && /\w/.test(lineText[wordStart - 1])) wordStart--;
      while (wordEnd < lineText.length && /\w/.test(lineText[wordEnd])) wordEnd++;

      const absStart = line.from + wordStart;
      const absEnd = line.from + wordEnd;

      if (wordStart < wordEnd) {
        // Cursor is on a word — check if already wrapped
        const before = state.sliceDoc(absStart - len, absStart);
        const after = state.sliceDoc(absEnd, absEnd + len);
        if (before === marker && after === marker &&
            !isAmbiguousUnwrap(doc, absStart - len, absEnd + len, marker)) {
          // Unwrap word
          return {
            range: EditorSelection.cursor(pos - len),
            changes: [
              { from: absStart - len, to: absStart, insert: '' },
              { from: absEnd, to: absEnd + len, insert: '' },
            ],
          };
        }

        // Wrap word
        const word = state.sliceDoc(absStart, absEnd);
        return {
          range: EditorSelection.cursor(absEnd + len),
          changes: { from: absStart, to: absEnd, insert: marker + word + marker },
        };
      }

      // Not on a word — check if cursor is between empty markers (toggle off)
      const before = state.sliceDoc(pos - len, pos);
      const after = state.sliceDoc(pos, pos + len);
      if (before === marker && after === marker) {
        return {
          range: EditorSelection.cursor(pos - len),
          changes: { from: pos - len, to: pos + len, insert: '' },
        };
      }

      // Insert empty markers with cursor between
      return {
        range: EditorSelection.cursor(pos + len),
        changes: { from: pos, to: pos, insert: marker + marker },
      };
    });

    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

export const toggleBold = toggleInlineFormat('**');
export const toggleItalic = toggleInlineFormat('*');

export const markdownFormattingKeymap = [
  { key: 'Mod-b' as const, run: toggleBold },
  { key: 'Mod-i' as const, run: toggleItalic },
];
