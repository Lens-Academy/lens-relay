// lens-editor/src/components/Comments/criticmarkupAdapter.ts
import { useMemo, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import type { ThreadView, MessageView, ThreadKey } from './types';
import { useCommentsFromText } from './useCommentsFromText';
import type { CommentThread, CriticMarkupRange } from '../../lib/criticmarkup-parser';
import {
  insertCommentInYText,
  replyInYText,
  editRangeContentInYText,
  deleteRangeInYText,
} from '../../lib/ytext-comment-ops';

export interface AdapterCallbacks {
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
  onAddComment: (key: ThreadKey, body: string) => void;
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
const pinned = new Map<string, { ytext: Y.Text; rel: Y.RelativePosition }>();

export function pinInsertKey(ytext: Y.Text, key: string): string {
  const pos = Number(key);
  if (Number.isFinite(pos)) pinned.set(key, { ytext, rel: Y.createRelativePositionFromTypeIndex(ytext, pos) });
  return key;
}

function insertPos(ytext: Y.Text, key: string): number | null {
  const pin = pinned.get(key);
  if (pin && pin.ytext === ytext && ytext.doc) {
    pinned.delete(key);
    const abs = Y.createAbsolutePositionFromRelativePosition(pin.rel, ytext.doc);
    if (abs && abs.type === ytext) return abs.index;
  }
  const pos = Number(key);
  return Number.isFinite(pos) ? Math.min(pos, ytext.length) : null;
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
        const range = rangeByMessageId.get(message.id);
        if (!range) return;
        deleteRangeInYText(yText, range);
      },
      onAddComment(key, body) {
        const pos = insertPos(yText, key);
        if (pos == null) return;
        insertCommentInYText(yText, body, pos);
      },
    };

    return { threads, callbacks };
  }, [rawThreads, yText, currentUserName, canDeleteAny]);
}
