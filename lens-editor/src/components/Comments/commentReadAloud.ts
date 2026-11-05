/**
 * Read-aloud of comments: while the page is being read aloud, a click on a
 * comment's text reads that comment thread from the clicked sentence to its
 * last reply, then playback stops and Play goes on with the page where it was
 * (ReadAloudEngine.playOther).
 *
 * The editor provides its engine through CommentReadAloudContext; without it
 * (no read-aloud, tests) comment clicks behave as usual.
 */

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReadAloudEngine, ReadingUnit } from '../../lib/read-aloud/engine';
import { splitSentences, type CharRange } from '../../lib/read-aloud/text';
import type { ThreadView } from './types';

export const CommentReadAloudContext = createContext<ReadAloudEngine | null>(null);

export function useCommentReadAloudEngine(): ReadAloudEngine | null {
  return useContext(CommentReadAloudContext);
}

/** Whether audio plays (or is about to): when a click on a comment reads it. Re-renders only when that changes. */
export function useReadAloudPlaying(engine: ReadAloudEngine | null): boolean {
  return useSyncExternalStore(engine?.subscribe ?? noopSubscribe, () => engine?.isPlaying ?? false);
}
const noopSubscribe = () => () => {};

/** Silence between one message of a thread and the next, in seconds. */
const MESSAGE_PAUSE_S = 0.5;

export interface ThreadReading {
  units: ReadingUnit[];
  /** Per unit: the message it comes from and where it sits in the message's body. */
  parts: Array<{ messageId: string; range: CharRange }>;
}

/** The engine source of a thread's reading. */
export function threadSource(thread: ThreadView): string {
  return `comment:${thread.key}`;
}

/** The thread's sentences: the first message's, then each reply's. */
export function buildThreadReading(thread: ThreadView): ThreadReading {
  const units: ReadingUnit[] = [];
  const parts: ThreadReading['parts'] = [];
  for (const message of [thread.root, ...thread.replies]) {
    splitSentences(message.body).forEach((range, k) => {
      units.push({ text: message.body.slice(range.start, range.end), pauseBefore: k === 0 ? MESSAGE_PAUSE_S : 0 });
      parts.push({ messageId: message.id, range });
    });
  }
  return { units, parts };
}

/** The unit to start from for a click at `offset` in a message's body: the sentence there, else the nearest one. */
export function unitAtOffset(reading: ThreadReading, messageId: string, offset: number): number | null {
  let last: number | null = null;
  for (let i = 0; i < reading.parts.length; i++) {
    const part = reading.parts[i];
    if (part.messageId !== messageId) continue;
    if (offset < part.range.end) return i;
    last = i;
  }
  return last;
}

/** Characters of `root`'s text before the point (x, y), or null when the point is not in it. */
export function textOffsetAtPoint(root: HTMLElement, x: number, y: number): number | null {
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) ({ offsetNode: node, offset } = pos);
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || !root.contains(node)) return null;
  const before = doc.createRange();
  before.setStart(root, 0);
  before.setEnd(node, offset);
  return before.toString().length;
}

/** What of a message is heard now: the sentence and word, as ranges in its body. */
export interface HeardInMessage {
  messageId: string;
  sentence: CharRange;
  word: CharRange | null;
}

/**
 * The part of `thread` being read aloud, or null. The reading is rebuilt from
 * the thread as shown, so it matches the units playOther was given as long as
 * the thread was not edited meanwhile (then the highlight is only off).
 */
export function useHeardInThread(engine: ReadAloudEngine | null, thread: ThreadView): HeardInMessage | null {
  const source = threadSource(thread);
  const [heard, setHeard] = useState<{ unit: number; word: CharRange | null } | null>(null);
  useEffect(() => {
    if (!engine) return;
    return engine.onHighlight(h => {
      const next = h && h.source === source ? { unit: h.unit, word: h.word } : null;
      setHeard(prev =>
        prev === next || (prev && next && prev.unit === next.unit && prev.word?.start === next.word?.start && prev.word?.end === next.word?.end)
          ? prev
          : next,
      );
    });
  }, [engine, source]);
  if (!heard) return null;
  const part = buildThreadReading(thread).parts[heard.unit];
  if (!part) return null;
  return {
    messageId: part.messageId,
    sentence: part.range,
    word: heard.word && { start: part.range.start + heard.word.start, end: part.range.start + heard.word.end },
  };
}
