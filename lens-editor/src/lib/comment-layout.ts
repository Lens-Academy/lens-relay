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

/** Anchored overlap resolution: pin one item at its targetY, push others outward. */
export function resolveOverlapsAnchored(
  items: LayoutItem[],
  gap: number = DEFAULT_GAP,
  anchorIndex: number,
): LayoutResult[] {
  if (items.length === 0) return [];

  const results: LayoutResult[] = new Array(items.length);

  // Pin anchor at its targetY
  results[anchorIndex] = { layoutY: items[anchorIndex].targetY };

  // Forward pass: anchor+1 → end (push down)
  let previousBottom = items[anchorIndex].targetY + items[anchorIndex].height;
  for (let i = anchorIndex + 1; i < items.length; i++) {
    const layoutY = Math.max(items[i].targetY, previousBottom + gap);
    results[i] = { layoutY };
    previousBottom = layoutY + items[i].height;
  }

  // Backward pass: anchor-1 → 0 (push up)
  let nextTop = items[anchorIndex].targetY;
  for (let i = anchorIndex - 1; i >= 0; i--) {
    const layoutY = Math.max(0, Math.min(items[i].targetY, nextTop - items[i].height - gap));
    results[i] = { layoutY };
    nextTop = layoutY;
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
