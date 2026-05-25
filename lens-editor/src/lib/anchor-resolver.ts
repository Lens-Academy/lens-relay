import type { EditorView } from '@codemirror/view';

/**
 * Resolve the screen-y of a Y.Text offset by asking a CodeMirror view where it
 * renders that position. Returns null if the position is not currently
 * rendered (e.g. inside a collapsed fold).
 */
export function resolveAnchorYFromView(
  view: EditorView,
  offset: number,
): number | null {
  const coords = view.coordsAtPos(offset);
  return coords ? coords.top : null;
}

/**
 * A section editor mounted in the course editor: a CodeMirror view rendering a
 * slice of the underlying Y.Text from `yTextFrom` (inclusive) to `yTextTo`
 * (exclusive). Local CM positions are `offset - yTextFrom`.
 */
export interface SectionViewEntry {
  view: EditorView;
  yTextFrom: number;
  yTextTo: number;
}

/**
 * Resolve a Y.Text offset across many section views. Walks the entries to find
 * the one whose slice contains the offset, then asks that view for the screen
 * y. Returns null if no section owns the offset or its view doesn't render it.
 */
export function resolveAnchorYFromSectionViews(
  entries: readonly SectionViewEntry[],
  offset: number,
): number | null {
  for (const entry of entries) {
    if (offset >= entry.yTextFrom && offset < entry.yTextTo) {
      const localPos = offset - entry.yTextFrom;
      return resolveAnchorYFromView(entry.view, localPos);
    }
  }
  return null;
}

/**
 * Resolve a Y.Text offset to a screen y by scanning the editor root for an
 * inline marker with `data-comment-from`. Use as a fallback to
 * `resolveAnchorYFromSectionViews`.
 */
export function resolveAnchorYFromDOM(
  root: HTMLElement,
  offset: number,
): number | null {
  const el = root.querySelector(
    `[data-comment-from="${offset}"]`,
  ) as HTMLElement | null;
  return el ? el.getBoundingClientRect().top : null;
}
