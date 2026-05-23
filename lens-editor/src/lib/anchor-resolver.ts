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
 * inline anchor element with the matching absolute offset.
 *
 * Two anchor forms are searched, in order:
 *   1. `.cm-comment-badge[data-thread-from="<offset>"]` — CodeMirror widget
 *      rendered by the criticmarkup extension (file editor; edit-mode section
 *      in course editor). After Task 8 these carry absolute offsets.
 *   2. `.cm-comment-anchor[data-cm-absolute-from="<offset>"]` — React span
 *      rendered by `renderMarkdownWithCriticMarkup` (read-mode sections in
 *      course editor).
 *
 * Returns the top y of the first match, or null if neither selector finds an
 * element. Use as a fallback to `resolveAnchorYFromSectionViews` when no CM
 * view owns the offset.
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
