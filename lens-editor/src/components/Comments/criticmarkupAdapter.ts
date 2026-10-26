// lens-editor/src/components/Comments/criticmarkupAdapter.ts
import { useMemo, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import type { ThreadView, MessageView, ThreadKey } from './types';
import { useCommentsFromText } from './useCommentsFromText';
import { parse, parseThreads, type CommentThread, type CriticMarkupRange } from '../../lib/criticmarkup-parser';
import {
  insertCommentInYText,
  replyInYText,
  editRangeContentInYText,
  deleteRangeInYText,
  removeThreadInYText,
} from '../../lib/ytext-comment-ops';

export interface AdapterCallbacks {
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  /** Deleting a thread's last message also removes its highlight */
  onDelete: (message: MessageView) => void;
  /** Removes the thread and its highlight, keeping the text (Notion's resolve) */
  onResolve: (thread: ThreadView) => void;
  /** Returns the new thread's key, when it differs from `key` (a highlight was added) */
  onAddComment: (key: ThreadKey, body: string) => ThreadKey | void;
}

export interface AdapterResult {
  threads: ThreadView[];
  callbacks: AdapterCallbacks;
}

function messageIdFor(range: CriticMarkupRange): string {
  const a = range.metadata?.author ?? '';
  const t = range.metadata?.timestamp != null ? String(range.metadata.timestamp) : '';
  return a && t ? `${a}|${t}` : `pos:${range.from}`;
}

/** The thread a message is in, as the Y.Text is now (its offsets may have moved since the render) */
function liveThread(ytext: Y.Text, messageId: string): { ranges: CriticMarkupRange[]; thread: CommentThread } | null {
  const ranges = parse(ytext.toString());
  const thread = parseThreads(ranges).find((t) => t.comments.some((c) => messageIdFor(c) === messageId));
  return thread ? { ranges, thread } : null;
}

function useYTextString(yText: Y.Text): string {
  return useSyncExternalStore(
    (onChange) => {
      const handler = () => onChange();
      yText.observe(handler);
      return () => yText.unobserve(handler);
    },
    () => yText.toString(),
  );
}

/**
 * `canDeleteAny`: the current user has edit access, so they may delete any
 * comment (e.g. once they fixed what it asks for), not only their own.
 * Editing a comment's text stays with its author.
 */
/**
 * A new comment's place, pinned when its form opens. The key the comments UI carries is a
 * plain offset, which goes stale while collaborators type above it; this keeps a Yjs
 * relative position beside it, which moves with their edits, for the insert to use.
 */
const pinned = new Map<string, { ytext: Y.Text; rel: Y.RelativePosition; relFrom: Y.RelativePosition | null }>();

/**
 * `highlightFrom`: the comment is on the text from there to the key's offset
 * (commentTarget), which it highlights; it is pinned the same way.
 */
export function pinInsertKey(ytext: Y.Text, key: string, highlightFrom?: number): string {
  const pos = Number(key);
  if (Number.isFinite(pos)) {
    pinned.set(key, {
      ytext,
      rel: Y.createRelativePositionFromTypeIndex(ytext, pos),
      relFrom: highlightFrom != null && highlightFrom < pos ? Y.createRelativePositionFromTypeIndex(ytext, highlightFrom) : null,
    });
  }
  return key;
}

function insertPos(ytext: Y.Text, key: string): { pos: number; highlightFrom?: number } | null {
  const pin = pinned.get(key);
  if (pin && pin.ytext === ytext && ytext.doc) {
    pinned.delete(key);
    const abs = Y.createAbsolutePositionFromRelativePosition(pin.rel, ytext.doc);
    if (abs && abs.type === ytext) {
      const from = pin.relFrom && Y.createAbsolutePositionFromRelativePosition(pin.relFrom, ytext.doc);
      // Only while the commented text is still there to highlight
      return from && from.type === ytext && from.index < abs.index
        ? { pos: abs.index, highlightFrom: from.index }
        : { pos: abs.index };
    }
  }
  const pos = Number(key);
  return Number.isFinite(pos) ? { pos: Math.min(pos, ytext.length) } : null;
}

export function useThreadsFromYText(
  yText: Y.Text,
  currentUserName: string,
  canDeleteAny = false,
): AdapterResult {
  const text = useYTextString(yText);
  const rawThreads = useCommentsFromText(text).filter(
    (t) => t.comments[0]?.type === 'comment',
  );

  return useMemo<AdapterResult>(() => {
    const rangeByMessageId = new Map<string, CriticMarkupRange>();
    const threadByKey = new Map<ThreadKey, CommentThread>();

    const projectMessage = (range: CriticMarkupRange): MessageView => {
      const id = messageIdFor(range);
      rangeByMessageId.set(id, range);
      const isOwn = range.metadata?.author === currentUserName;
      return {
        id,
        author: range.metadata?.author ?? 'unknown',
        // range.content is already decoded by the parser (decodeCommentContent
        // is called inside parse() for comment type), so use it directly.
        body: range.content,
        timestamp: range.metadata?.timestamp != null ? String(range.metadata.timestamp) : '',
        canModify: isOwn,
        canDelete: isOwn || canDeleteAny,
      };
    };

    const threads: ThreadView[] = rawThreads.map((thread, i) => {
      const key = String(thread.from);
      threadByKey.set(key, thread);
      return {
        key,
        root: projectMessage(thread.comments[0]),
        replies: thread.comments.slice(1).map(projectMessage),
        order: i + 1,
        orphan: false,
      };
    });

    const callbacks: AdapterCallbacks = {
      onReply(thread, body) {
        // By offset, else by root comment: the offset may have moved since the card rendered.
        const live = threadByKey.get(thread.key)
          ?? rawThreads.find((t) => messageIdFor(t.comments[0]) === thread.root.id);
        if (!live) return;
        replyInYText(yText, body, live.to);
      },
      onEdit(message, body) {
        const range = rangeByMessageId.get(message.id);
        if (!range) return;
        editRangeContentInYText(yText, range, body);
      },
      onDelete(message) {
        const live = liveThread(yText, message.id);
        if (live?.thread.comments.length === 1) {
          removeThreadInYText(yText, live.ranges, live.thread.comments);
          return;
        }
        const range = live?.thread.comments.find((c) => messageIdFor(c) === message.id) ?? rangeByMessageId.get(message.id);
        if (!range) return;
        deleteRangeInYText(yText, range);
      },
      onResolve(thread) {
        const live = liveThread(yText, thread.root.id);
        if (live) removeThreadInYText(yText, live.ranges, live.thread.comments);
      },
      onAddComment(key, body) {
        const at = insertPos(yText, key);
        if (at == null) return;
        return String(insertCommentInYText(yText, body, at.pos, at.highlightFrom));
      },
    };

    return { threads, callbacks };
  }, [rawThreads, yText, currentUserName, canDeleteAny]);
}
