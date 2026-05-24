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
 * inline anchor element. Searches both flavors: `.cm-comment-badge` (CM
 * widget) and `.cm-comment-anchor` (read-mode React span). Both carry
 * absolute offsets. Returns null if nothing matches; use as a fallback to
 * `resolveAnchorYFromSectionViews`.
 */
export function resolveAnchorYFromDOM(
  root: HTMLElement,
  offset: number,
): number | null {
  const cm = root.querySelector(
    `.cm-comment-badge[data-thread-from="${offset}"]`,
  ) as HTMLElement | null;
  if (cm) return cm.getBoundingClientRect().top;

  const react = root.querySelector(
    `.cm-comment-anchor[data-cm-absolute-from="${offset}"]`,
  ) as HTMLElement | null;
  if (react) return react.getBoundingClientRect().top;

  return null;
}
