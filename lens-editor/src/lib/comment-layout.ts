import type { CommentThread } from './criticmarkup-parser';

export type PositionMapper = (pos: number) => number;

export interface LayoutItem {
  targetY: number;
  height: number;
}

export interface LayoutResult {
  layoutY: number;
}

const DEFAULT_GAP = 4;
const DEFAULT_PADDING = 64;

/** Greedy top-down overlap resolution. */
export function resolveOverlaps(items: LayoutItem[], gap: number = DEFAULT_GAP): LayoutResult[] {
  if (items.length === 0) return [];

  const results: LayoutResult[] = [];
  let previousBottom = -Infinity;

  for (const item of items) {
    const layoutY = Math.max(item.targetY, previousBottom + gap);
    results.push({ layoutY });
    previousBottom = layoutY + item.height;
  }

  return results;
}

/** Compute shared scrollable height for both containers. */
export function computeSharedHeight(
  editorScrollHeight: number,
  lastCardBottom: number,
  padding: number = DEFAULT_PADDING,
): number {
  return Math.max(editorScrollHeight, lastCardBottom + padding);
}

/** Compute extra bottom padding needed for the editor (0 if editor is already tall enough). */
export function computeEditorPadding(
  editorScrollHeight: number,
  lastCardBottom: number,
  padding: number = DEFAULT_PADDING,
): number {
  if (lastCardBottom <= editorScrollHeight) return 0;
  return lastCardBottom + padding - editorScrollHeight;
}

/** Map thread positions to target Y coordinates using a PositionMapper. */
export function mapThreadPositions(
  threads: CommentThread[],
  mapper: PositionMapper,
): { thread: CommentThread; badgeNumber: number; targetY: number }[] {
  return threads.map((thread, index) => ({
    thread,
    badgeNumber: index + 1,
    targetY: mapper(thread.from),
  }));
}
