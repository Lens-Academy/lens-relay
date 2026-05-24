// lens-editor/src/components/HtmlEditor/htmlCommentsAdapter.ts
import { useMemo, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import type { ThreadView, MessageView, ScrollSource } from '../Comments/types';
import {
  parseComments,
  addReply,
  editMessage,
  deleteMessage,
  type CommentCluster,
} from './comment-store';
import { LENS_EDITOR_ORIGIN } from '../../lib/relay-api';

export interface AnchorRect { y: number; x: number; w: number; h: number }
export type AnchorState = Map<string, AnchorRect>;

export interface HtmlAdapterCallbacks {
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
}

export interface HtmlAdapterResult {
  threads: ThreadView[];
  callbacks: HtmlAdapterCallbacks;
}

export function effectiveY(
  rect: AnchorRect,
  baselineScrollY: number,
  currentScrollY: number,
  iframeTop: number,
): number {
  return iframeTop + rect.y - (currentScrollY - baselineScrollY);
}

function projectCluster(
  cluster: CommentCluster,
  order: number,
  currentUser: string,
  orphan: boolean,
): ThreadView {
  const root: MessageView = {
    id: cluster.comment.id,
    author: cluster.comment.author,
    body: cluster.comment.body,
    timestamp: cluster.comment.ts,
    canModify: cluster.comment.author === currentUser,
  };
  const replies: MessageView[] = cluster.replies.map(r => ({
    id: r.id,
    author: r.author,
    body: r.body,
    timestamp: r.ts,
    canModify: r.author === currentUser,
  }));
  return { key: cluster.comment.id, root, replies, order, orphan };
}

function useYTextString(yText: Y.Text): string {
  return useSyncExternalStore(
    (cb) => {
      const handler = (): void => cb();
      yText.observe(handler);
      return () => yText.unobserve(handler);
    },
    () => yText.toString(),
  );
}

function makeId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function useThreadsFromHtmlYText(
  yText: Y.Text,
  anchorState: AnchorState,
  currentUserName: string,
): HtmlAdapterResult {
  const source = useYTextString(yText);

  return useMemo<HtmlAdapterResult>(() => {
    const clusters = parseComments(source);
    const threads = clusters.map((c, i) =>
      projectCluster(c, i + 1, currentUserName, !anchorState.has(c.comment.id))
    );

    const callbacks: HtmlAdapterCallbacks = {
      onReply(thread, body) {
        addReply(yText, LENS_EDITOR_ORIGIN, {
          id: makeId(),
          parent: thread.key,
          author: currentUserName,
          ts: new Date().toISOString(),
          body,
        });
      },
      onEdit(message, newBody) {
        editMessage(yText, LENS_EDITOR_ORIGIN, { id: message.id, newBody });
      },
      onDelete(message) {
        deleteMessage(yText, LENS_EDITOR_ORIGIN, message.id);
      },
    };

    return { threads, callbacks };
  }, [source, anchorState, yText, currentUserName]);
}

export interface IframeScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface IframeScrollSource extends ScrollSource {
  notify(): void;
}

export function makeIframeScrollSource(getState: () => IframeScrollState): IframeScrollSource {
  const subs = new Set<() => void>();
  return {
    getScrollTop: () => getState().scrollTop,
    getScrollHeight: () => getState().scrollHeight,
    getClientHeight: () => getState().clientHeight,
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
    notify() {
      subs.forEach(fn => fn());
    },
  };
}
