/**
 * Shared types for the Comments sidebar and inline comment display.
 */

export type ThreadKey = string;

export interface MessageView {
  /** Stable identity that survives offset shifts. Used as React key and as a
   *  handle the layer hands back to callbacks; never decoded by the layer. */
  id: string;
  author: string;
  body: string;
  timestamp: string;
  canModify: boolean;
}

export interface ThreadView {
  key: ThreadKey;
  root: MessageView;
  replies: MessageView[];
  /** 1..N display index; matches inline-badge numbering in the prose. */
  order: number;
  /** Anchor unresolvable in the current render (no on-screen position). */
  orphan: boolean;
}

export interface ScrollSource {
  getScrollTop(): number;
  getScrollHeight(): number;
  getClientHeight(): number;
  subscribe(onChange: () => void): () => void;
}
