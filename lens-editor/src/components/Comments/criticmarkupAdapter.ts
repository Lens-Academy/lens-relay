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
import { mdResolveMap, setMdResolved, type MdResolveInfo } from '../../lib/md-comment-resolve';

export interface AdapterCallbacks {
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
  onAddComment: (key: ThreadKey, body: string) => void;
  /** Mark a thread resolved — reversible, allowed for anyone with edit access
   *  (not just the author), mirroring the HTML editor. */
  onResolve: (thread: ThreadView) => void;
  onReopen: (thread: ThreadView) => void;
}

export interface AdapterResult {
  threads: ThreadView[];
  callbacks: AdapterCallbacks;
}

function messageIdFor(range: CriticMarkupRange): string {
  const a = range.metadata?.author ?? '';
  const t = range.metadata?.timestamp != null ? String(range.metadata.timestamp) : '';
  if (a && t) return `${a}|${t}`;
  // Legacy comments with no author/timestamp have no stable identity; fall back
  // to position plus a content prefix (best-effort). The content prefix makes a
  // mis-attributed resolve far less likely when a comment shifts onto another's
  // old offset, but cannot rule it out for identical-content comments; such
  // resolve state is simply lost on drift rather than reliably preserved.
  return `pos:${range.from}:${range.content.slice(0, 64)}`;
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

/** A serialized snapshot of the out-of-band resolve map, used both as a memo
 *  key (it changes by value when any thread is resolved/reopened, locally or
 *  remotely) and to re-render on remote resolve changes. Returns '' as a
 *  defensive fallback for a Y.Text with no doc (integrated texts always have
 *  one). */
function useMdResolveSnapshot(doc: Y.Doc | null): string {
  return useSyncExternalStore(
    (onChange) => {
      if (!doc) return () => {};
      const map = mdResolveMap(doc);
      const handler = () => onChange();
      map.observe(handler);
      return () => map.unobserve(handler);
    },
    () => (doc ? JSON.stringify(Array.from(mdResolveMap(doc).entries())) : ''),
  );
}

/**
 * @param canModifyComments whether this viewer has edit access. Gates the
 *   per-message Edit/Delete affordance (still author-locked on top of it) and,
 *   via the actions the caller builds from the returned callbacks, Resolve.
 *   Defaults to true so existing callers and tests keep their behaviour.
 */
export function useThreadsFromYText(
  yText: Y.Text,
  currentUserName: string,
  canModifyComments = true,
): AdapterResult {
  const text = useYTextString(yText);
  const doc = yText.doc ?? null;
  const resolveSnapshot = useMdResolveSnapshot(doc);
  const rawThreads = useCommentsFromText(text).filter(
    (t) => t.comments[0]?.type === 'comment',
  );

  // Resolve state by thread-root id, parsed from the out-of-band map snapshot.
  // Parsing the stable snapshot string (rather than reading the Y.Map per
  // thread) keeps it a referenced memo dependency and recomputes on remote
  // resolve changes.
  const resolveByRootId = useMemo<Map<string, MdResolveInfo>>(() => {
    const out = new Map<string, MdResolveInfo>();
    if (!resolveSnapshot) return out;
    try {
      for (const [id, value] of JSON.parse(resolveSnapshot) as [string, unknown][]) {
        if (value && typeof value === 'object') {
          const v = value as Record<string, unknown>;
          out.set(id, {
            by: typeof v.by === 'string' ? v.by : 'someone',
            at: typeof v.at === 'number' ? v.at : 0,
          });
        }
      }
    } catch {
      // Ignore a malformed snapshot; treat everything as unresolved.
    }
    return out;
  }, [resolveSnapshot]);

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
        // Editing/deleting a message stays author-locked (as in the HTML
        // editor), and additionally requires edit access.
        canModify: canModifyComments && range.metadata?.author === currentUserName,
      };
    };

    // Resolve state keyed by the thread's root-comment identity (stable across
    // offset shifts), read from the out-of-band map.
    const rootIdByThreadKey = new Map<ThreadKey, string>();

    const threads: ThreadView[] = rawThreads.map((thread, i) => {
      const key = String(thread.from);
      threadByKey.set(key, thread);
      const root = projectMessage(thread.comments[0]);
      rootIdByThreadKey.set(key, root.id);
      const resolved = resolveByRootId.get(root.id) ?? null;
      return {
        key,
        root,
        replies: thread.comments.slice(1).map(projectMessage),
        order: i + 1,
        orphan: false,
        ...(resolved
          ? { resolved: { by: resolved.by, at: resolved.at ? String(resolved.at) : '' } }
          : {}),
      };
    });

    const setResolved = (thread: ThreadView, resolved: boolean) => {
      if (!doc) return;
      const rootId = rootIdByThreadKey.get(thread.key);
      if (!rootId) return;
      setMdResolved(doc, rootId, resolved, currentUserName);
    };

    const callbacks: AdapterCallbacks = {
      onReply(thread, body) {
        const live = threadByKey.get(thread.key);
        if (!live) return;
        replyInYText(yText, body, live.to);
        // A reply reopens a resolved thread, as in the HTML editor
        // (thread-store.addMessage), so a follow-up objection is not hidden
        // behind the Resolved state.
        setResolved(thread, false);
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
      onResolve(thread) {
        setResolved(thread, true);
      },
      onReopen(thread) {
        setResolved(thread, false);
      },
    };

    return { threads, callbacks };
  }, [rawThreads, yText, doc, currentUserName, canModifyComments, resolveByRootId]);
}
