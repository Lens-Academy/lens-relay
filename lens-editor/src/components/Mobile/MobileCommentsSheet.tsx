import { useState, useEffect, useRef } from 'react';
import { CommentCard } from '../Comments/CommentCard';
import { AddCommentForm } from '../Comments/AddCommentForm';
import type { ThreadKey, ThreadView, MessageView } from '../Comments/types';

/** Action the editor requested before/while the sheet opened. */
export type PendingCommentAction =
  | { type: 'focus'; key: ThreadKey }
  | { type: 'add'; key: ThreadKey }
  | null;

export interface MobileCommentsSheetProps {
  threads: ThreadView[];
  pendingAction: PendingCommentAction;
  onPendingActionConsumed: () => void;
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
  onAddComment?: (key: ThreadKey, body: string) => void;
  /** Anchor key for a new comment at the current cursor, or null when unavailable. */
  getInsertKey?: () => ThreadKey | null;
}

/**
 * Mobile replacement for the desktop comment margin: a plain scrollable list
 * of threads in document order, rendered inside a bottom sheet. No anchored
 * PAV layout — badges in the prose open the sheet focused on their thread.
 */
export function MobileCommentsSheet(props: MobileCommentsSheetProps) {
  const { threads, pendingAction, onPendingActionConsumed, onReply, onEdit, onDelete, onAddComment, getInsertKey } = props;
  // The pending focus/add request (badge tap, context menu) is consumed at
  // mount — the parent keys this component on the request so it remounts.
  const [focusedKey, setFocusedKey] = useState<ThreadKey | null>(
    () => (pendingAction?.type === 'focus' ? pendingAction.key : null),
  );
  const [addFormKey, setAddFormKey] = useState<ThreadKey | null>(
    () => (pendingAction?.type === 'add' ? pendingAction.key : null),
  );
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pendingAction) onPendingActionConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consume once at mount
  }, []);

  // Scroll the focused thread into view
  useEffect(() => {
    if (focusedKey == null || !listRef.current) return;
    listRef.current
      .querySelector(`[data-comment-thread="${focusedKey}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [focusedKey]);

  const canAdd = onAddComment != null && getInsertKey != null;

  return (
    <div ref={listRef} className="px-3 pb-4 space-y-2.5">
      <div className="flex items-center justify-between pb-1">
        <h2 className="text-sm font-semibold text-gray-700">Comments</h2>
        {canAdd && addFormKey == null && (
          <button
            type="button"
            className="text-sm font-semibold text-white bg-blue-500 rounded-md px-4 py-2.5 active:bg-blue-600"
            onClick={() => {
              const key = getInsertKey();
              if (key != null) setAddFormKey(key);
            }}
          >
            + Add
          </button>
        )}
      </div>

      {addFormKey != null && onAddComment && (
        <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
          <AddCommentForm
            onSubmit={(body) => {
              onAddComment(addFormKey, body);
              setAddFormKey(null);
              setFocusedKey(addFormKey);
            }}
            onCancel={() => setAddFormKey(null)}
            placeholder="Add a comment..."
            submitLabel="Add"
            autoFocus
          />
        </div>
      )}

      {threads.length === 0 && addFormKey == null && (
        <p className="py-8 text-center text-sm text-gray-400">
          No comments yet.{canAdd ? ' Select text in the note and tap + Add.' : ''}
        </p>
      )}

      {threads.map((thread) => (
        <div key={thread.key} data-comment-thread={thread.key}>
          <CommentCard
            thread={thread}
            number={thread.order}
            focused={focusedKey === thread.key}
            onFocus={(key) => setFocusedKey(prev => (prev === key ? null : key))}
            onReply={onReply}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      ))}
    </div>
  );
}
