export interface Fingerprint {
  before: string;
  after: string;
  tag: string;
  ancestorPath: Array<{ tag: string; index: number }>;
  clickRect: { x: number; y: number; w: number; h: number };
}

export interface CommentSummary {
  id: string;
  body: string;
  replies: number;
  /** 1-indexed document order; mirrors the sidebar card's badge number. */
  order: number;
}

export interface ViewportPoint {
  x: number;
  y: number;
}

export interface PreviewScroll {
  x: number;
  y: number;
}

export interface CommentRect {
  id: string;
  y: number;
  x: number;
  w: number;
  h: number;
}

export interface CommentsRenderedPayload {
  found: string[];
  orphaned: string[];
  rects: CommentRect[];
  /** Iframe scroll-y at the moment rects were measured. The parent uses this
   *  with the latest scroll-state to derive viewport-y from delta. */
  baselineScrollY: number;
  /** Monotonic counter bumped on every layout-affecting change. The parent
   *  discards scroll-state messages whose layoutVersion doesn't match. */
  layoutVersion: number;
}

export interface PreviewScrollState extends PreviewScroll {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /** Echo of the bridge's latest layoutVersion. The parent uses this to
   *  discard scroll-state messages that race ahead of the corresponding
   *  comments-rendered message. */
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

export type PlacementTrigger = 'contextmenu' | 'selection' | 'toolbar';

export interface PlacementRequest {
  trigger: PlacementTrigger;
  fingerprint: Fingerprint;
  point: ViewportPoint;
  scroll: PreviewScroll;
}

export type ParentToBridge =
  | { type: 'init'; payload: { comments: CommentSummary[] } }
  | { type: 'enable-click-to-place'; payload: Record<string, never> }
  | { type: 'disable-click-to-place'; payload: Record<string, never> }
  | { type: 'find-probe'; payload: { token: string } }
  | { type: 'highlight-comment'; payload: { id: string } }
  | { type: 'set-comments'; payload: { comments: CommentSummary[] } }
  | { type: 'restore-scroll'; payload: PreviewScroll }
  | { type: 'restore-scroll-ratio'; payload: PreviewScrollRatio }
  | { type: 'capture-ui-state'; payload: Record<string, never> }
  | { type: 'restore-ui-state'; payload: PreviewUiState }
  | { type: 'set-focused-comment'; payload: { id: string | null } };

export type BridgeToParent =
  | { type: 'ready'; payload: Record<string, never> }
  | { type: 'click-captured'; payload: { fingerprint: Fingerprint } }
  | { type: 'dot-clicked'; payload: { id: string } }
  | { type: 'placement-requested'; payload: PlacementRequest }
  | { type: 'scroll-state'; payload: PreviewScrollState }
  | { type: 'ui-state'; payload: PreviewUiState }
  | { type: 'probe-found'; payload: { token: string; rect: { x: number; y: number; w: number; h: number } | null } }
  | { type: 'comments-rendered'; payload: CommentsRenderedPayload };

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
