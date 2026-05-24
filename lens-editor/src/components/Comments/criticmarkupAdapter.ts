// lens-editor/src/components/Comments/criticmarkupAdapter.ts
import { useMemo, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
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

export function useThreadsFromYText(yText: Y.Text, currentUserName: string): AdapterResult {
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
      return {
        id,
        author: range.metadata?.author ?? 'unknown',
        // range.content is already decoded by the parser (decodeCommentContent
        // is called inside parse() for comment type), so use it directly.
        body: range.content,
        timestamp: range.metadata?.timestamp != null ? String(range.metadata.timestamp) : '',
        canModify: range.metadata?.author === currentUserName,
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
        const live = threadByKey.get(thread.key);
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
        const pos = Number(key);
        if (!Number.isFinite(pos)) return;
        insertCommentInYText(yText, body, pos);
      },
    };

    return { threads, callbacks };
  }, [rawThreads, yText, currentUserName]);
}
