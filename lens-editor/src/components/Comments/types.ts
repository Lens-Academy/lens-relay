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

/** Where an out-of-band thread points (HTML pages); absent for inline comments. */
export interface ThreadAnchorInfo {
  /** What was commented on: the quoted text, or a description of an element. */
  target: string;
  /** locating: the page has not finished rendering yet. */
  state: 'anchored' | 'guessed' | 'hidden' | 'orphaned' | 'locating';
  /** For a guessed anchor: the text it is attached to now. */
  currentText?: string;
  /** Nearest heading before the target, when known. */
  section?: string;
}

/** Thread-level actions a comment source may support (HTML pages do). */
export interface ThreadActions {
  onResolve?: (thread: ThreadView) => void;
  onReopen?: (thread: ThreadView) => void;
  /** Accept a guessed anchor as the right place. */
  onConfirmAnchor?: (thread: ThreadView) => void;
  /** Pick a new place for the thread in the page. */
  onReattach?: (thread: ThreadView) => void;
}

export interface ThreadView {
  key: ThreadKey;
  root: MessageView;
  replies: MessageView[];
  /** 1..N display index; matches inline-badge numbering in the prose. */
  order: number;
  /** Anchor unresolvable in the current render (no on-screen position). */
  orphan: boolean;
  anchor?: ThreadAnchorInfo;
  /** Set when the thread is resolved. */
  resolved?: { by: string; at: string };
}

export interface ScrollSource {
  getScrollTop(): number;
  getScrollHeight(): number;
  getClientHeight(): number;
  subscribe(onChange: () => void): () => void;
}
