import type { AnchorState, HtmlAnchor } from '../anchoring/types';

export interface PreviewScroll {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PreviewScrollState extends PreviewScroll {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /** Echo of the bridge's latest layoutVersion. The parent uses this to
   *  discard scroll-state messages that race ahead of the corresponding
   *  threads-resolved message. */
  layoutVersion: number;
}

export interface PreviewScrollRatio {
  xRatio: number;
  yRatio: number;
}

export interface DetailsStateItem {
  path: number[];
  open: boolean;
}

export interface PreviewUiState {
  details: DetailsStateItem[];
}

/** Something that went wrong while the page ran, reported by the bridge. */
export interface PageProblem {
  /** error: uncaught error or rejection; blocked: refused by the page CSP;
   *  load-failed: a script, stylesheet, image or module import did not load;
   *  overflow: the page is wider than its frame (reported while it lasts). */
  kind: 'error' | 'blocked' | 'load-failed' | 'overflow';
  message: string;
  /** URL of the blocked/failed resource, or `page:<line>` for page errors. */
  source?: string;
  count: number;
}

/** One change to the page's localStorage, in the order the page made it. */
export type StorageOp =
  | { op: 'set'; key: string; value: string }
  | { op: 'remove'; key: string }
  | { op: 'clear' };

/** A thread as the bridge needs it: where it points and how to draw it. */
export interface ThreadMark {
  id: string;
  anchor: HtmlAnchor;
  /** Badge number, matching the sidebar card. */
  order: number;
  resolved: boolean;
}

export interface ThreadPlacement {
  id: string;
  state: AnchorState;
  /** Viewport rect (at `baselineScrollY`) of the target, or of the nearest
   *  visible ancestor when hidden. Null when orphaned. */
  rect: Rect | null;
  /** Offset into the page's visible text, for document-order numbering. */
  textOffset: number | null;
  /** The text the anchor resolved to now (guessed and drifted anchors). */
  currentQuote?: string;
  /** A fresh anchor for a confidently found but drifted target, so the
   *  parent can keep the stored anchor current. */
  refreshed?: HtmlAnchor;
}

export interface ThreadsResolvedPayload {
  placements: ThreadPlacement[];
  draft: ThreadPlacement | null;
  baselineScrollY: number;
  /** Monotonic counter bumped on every layout-affecting change. */
  layoutVersion: number;
  /** The page has loaded and its DOM has been quiet for a while: an
   *  orphaned result now means the target is gone, not still rendering. */
  settled: boolean;
}

export type CaptureVia = 'selection' | 'click' | 'element';

export interface AnchorCapture {
  anchor: HtmlAnchor;
  /** Viewport rect of the target, to place the composer near it. */
  rect: Rect;
  via: CaptureVia;
  /** Heads-up for the author, e.g. the text repeats with nothing unique around it. */
  warning?: string;
}

export type ParentToBridge =
  | { type: 'init'; payload: Record<string, never> }
  | { type: 'set-threads'; payload: { threads: ThreadMark[] } }
  | { type: 'set-draft'; payload: { anchor: HtmlAnchor | null } }
  | { type: 'set-focused-thread'; payload: { id: string | null; reveal: boolean } }
  | { type: 'set-comment-mode'; payload: { on: boolean } }
  | { type: 'capture-selection'; payload: Record<string, never> }
  | { type: 'describe-legacy'; payload: { ids: string[] } }
  | { type: 'describe-current'; payload: { id: string } }
  | { type: 'restore-scroll'; payload: PreviewScroll }
  | { type: 'restore-scroll-ratio'; payload: PreviewScrollRatio }
  | { type: 'capture-ui-state'; payload: Record<string, never> }
  | { type: 'restore-ui-state'; payload: PreviewUiState };

export type BridgeToParent =
  | { type: 'ready'; payload: Record<string, never> }
  | { type: 'scroll-state'; payload: PreviewScrollState }
  | { type: 'ui-state'; payload: PreviewUiState }
  | { type: 'threads-resolved'; payload: ThreadsResolvedPayload }
  | { type: 'thread-clicked'; payload: { id: string } }
  | { type: 'anchor-captured'; payload: AnchorCapture }
  | { type: 'comment-mode-exit'; payload: Record<string, never> }
  | { type: 'shortcut'; payload: { key: 'c' } }
  | { type: 'selection-changed'; payload: { rect: Rect | null } }
  | { type: 'legacy-described'; payload: { anchors: Record<string, HtmlAnchor | null> } }
  | { type: 'current-described'; payload: { id: string; anchor: HtmlAnchor | null } }
  | { type: 'page-problems'; payload: { problems: PageProblem[] } }
  | { type: 'storage-ops'; payload: { ops: StorageOp[] } };

export interface Envelope<M> {
  nonce: string;
  message: M;
}

export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function validateEnvelope<M>(env: unknown, expectedNonce: string): M | null {
  if (typeof env !== 'object' || env === null) return null;
  const e = env as { nonce?: unknown; message?: unknown };
  if (typeof e.nonce !== 'string' || e.nonce !== expectedNonce) return null;
  if (typeof e.message !== 'object' || e.message === null) return null;
  return e.message as M;
}
