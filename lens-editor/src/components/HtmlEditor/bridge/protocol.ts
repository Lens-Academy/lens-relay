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
}

export interface ViewportPoint {
  x: number;
  y: number;
}

export interface PreviewScroll {
  x: number;
  y: number;
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
  | { type: 'restore-scroll'; payload: PreviewScroll };

export type BridgeToParent =
  | { type: 'ready'; payload: Record<string, never> }
  | { type: 'click-captured'; payload: { fingerprint: Fingerprint } }
  | { type: 'dot-clicked'; payload: { id: string } }
  | { type: 'placement-requested'; payload: PlacementRequest }
  | { type: 'probe-found'; payload: { token: string; rect: { x: number; y: number; w: number; h: number } | null } }
  | { type: 'comments-rendered'; payload: { found: string[]; orphaned: string[] } };

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
