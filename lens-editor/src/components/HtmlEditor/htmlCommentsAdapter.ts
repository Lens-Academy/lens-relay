// lens-editor/src/components/HtmlEditor/htmlCommentsAdapter.ts
// Maps preview-frame coordinates and scrolling onto the shared CommentsLayer.
import type { ScrollSource } from '../Comments/types';

export interface AnchorRect { y: number; x: number; w: number; h: number }

/** Screen y of a rect measured in the frame at `baselineScrollY`, after the
 *  frame has scrolled to `currentScrollY`. */
export function effectiveY(
  rect: AnchorRect,
  baselineScrollY: number,
  currentScrollY: number,
  iframeTop: number,
): number {
  return iframeTop + rect.y - (currentScrollY - baselineScrollY);
}

export interface IframeScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface IframeScrollSource extends ScrollSource {
  notify(): void;
}

export function makeIframeScrollSource(getState: () => IframeScrollState): IframeScrollSource {
  const subs = new Set<() => void>();
  return {
    getScrollTop: () => getState().scrollTop,
    getScrollHeight: () => getState().scrollHeight,
    getClientHeight: () => getState().clientHeight,
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
    notify() {
      subs.forEach(fn => fn());
    },
  };
}
