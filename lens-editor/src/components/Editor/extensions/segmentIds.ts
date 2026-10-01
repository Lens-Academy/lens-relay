/**
 * Segment id on Enter
 *
 * Pressing Enter at the end of a Question / Roleplay / Interview header whose
 * segment has no `id::` yet inserts `id:: <uuid>` on the next line and puts the
 * cursor on a fresh line below it, ready for `content::`. The platform rejects
 * these segments without an id (see shared/segment-ids.ts).
 *
 * Only in Lens Edu documents, and only on Enter: pasted segments keep the ids
 * they bring, and a segment that already has an `id::` is left alone.
 */
import type { StateCommand, EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { blockHasId, isSurveyPath, needsSegmentId } from '../../../../shared/segment-ids';
import { generateUUID } from '../../../lib/relay-api';

/** Same scope as the Harper linter: documents inside the Lens Edu folder. */
function isLensEduPath(path: string | null): path is string {
  return !!path && path.startsWith('/Lens Edu/');
}

function inCodeBlock(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
  }
  return false;
}

function* linesAfter(state: EditorState, lineNumber: number): Generator<string> {
  for (let n = lineNumber + 1; n <= state.doc.lines; n++) yield state.doc.line(n).text;
}

export function segmentIdEnter(
  getCurrentFilePath: () => string | null,
  newId: () => string = generateUUID,
): StateCommand {
  return ({ state, dispatch }) => {
    const path = getCurrentFilePath();
    if (!isLensEduPath(path)) return false;
    if (state.selection.ranges.length !== 1) return false;
    const { main } = state.selection;
    if (!main.empty) return false;

    const line = state.doc.lineAt(main.head);
    if (main.head !== line.to) return false;
    if (!needsSegmentId(line.text, isSurveyPath(path))) return false;
    if (inCodeBlock(state, line.from)) return false;
    if (blockHasId(linesAfter(state, line.number))) return false;

    const insert = `\nid:: ${newId()}\n`;
    dispatch(state.update({
      changes: { from: line.to, insert },
      selection: { anchor: line.to + insert.length },
      scrollIntoView: true,
      userEvent: 'input',
    }));
    return true;
  };
}

/** Install at Prec.high, ahead of the markdown Enter keymap. */
export function segmentIdKeymap(getCurrentFilePath: () => string | null) {
  return [{ key: 'Enter' as const, run: segmentIdEnter(getCurrentFilePath) }];
}
