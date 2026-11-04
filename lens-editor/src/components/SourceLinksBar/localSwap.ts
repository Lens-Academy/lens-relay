import { ChangeSet, Facet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type * as Y from 'yjs';
import { swapLinkEdits, type LinkEdit } from '../../../shared/external-links';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import { computeRelativePath } from '../../lib/document-resolver';

/** The page's undo history, so a swap can be a step of its own. y-codemirror
 *  keeps its own facet to itself. */
export const pageUndoManager = Facet.define<Y.UndoManager, Y.UndoManager | null>({
  combine: (values) => values[0] ?? null,
});

/** A source the library has, with every spelling of it to replace. */
export interface LibraryHit {
  urls: string[];
  /** Full relay path of the library copy. */
  path: string;
  title?: string;
}

/**
 * Swaps links for wikilinks in the open editor, all in one transaction. Done
 * here rather than by the server because then it is the person's own edit: on
 * their undo stack, so Ctrl+Z brings the link back, and one change for anyone
 * reading further down. Returns the URLs swapped; anything else is the server's.
 */
export function swapLinksInEditor(
  view: EditorView,
  ytextLength: number,
  metadata: FolderMetadata,
  pagePath: string,
  hits: LibraryHit[],
): string[] {
  const { state } = view;
  // Out of step with the Y.Text, offsets here would land in the wrong place
  if (state.readOnly || ytextLength !== state.doc.length) return [];

  const text = state.doc.toString();
  const edits: LinkEdit[] = [];
  const swapped: string[] = [];
  for (const { urls, path, title } of hits) {
    const target = `/${path}`;
    if (!metadata[target]) continue;
    const found = swapLinkEdits(text, urls, computeRelativePath(pagePath, target), title);
    if (found.length === 0) continue;
    edits.push(...found);
    swapped.push(...urls);
  }
  if (edits.length === 0) return [];

  const changes = ChangeSet.of(edits.sort((a, b) => a.from - b.from), state.doc.length);
  const undoManager = state.facet(pageUndoManager);
  undoManager?.stopCapturing();
  // No userEvent: Suggesting mode, which doesn't get here, would wrap it
  view.dispatch({ changes, selection: state.selection.map(changes, 1) });
  undoManager?.stopCapturing();
  return swapped;
}
