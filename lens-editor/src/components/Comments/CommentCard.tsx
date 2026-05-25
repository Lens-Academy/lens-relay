import { useState, type ReactElement } from 'react';
import type { ThreadView, MessageView, ThreadKey } from './types';
import { formatTimestamp } from '../../lib/format-timestamp';
import { AddCommentForm } from './AddCommentForm';
import { ConfirmDialog } from '../ConfirmDialog';

export interface CommentCardProps {
  thread: ThreadView;
  /** 1-indexed comment number, matching the inline badge in the prose. */
  number?: number;
  focused: boolean;
  onFocus: (key: ThreadKey) => void;
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
}

const CARD_BORDER = '#e8e5df';

export function CommentCard(props: CommentCardProps): ReactElement {
  const { thread, number, focused, onFocus, onReply, onEdit, onDelete } = props;

  const [showReplyForm, setShowReplyForm] = useState(false);

  const root = thread.root;
  const replies = thread.replies;

  const handleCardClick = () => {
    // Interactive subtrees stopPropagation, so any click reaching here is on the card body.
    onFocus(thread.key);
  };

  const handleReplySubmit = (content: string) => {
    onReply(thread, content);
    setShowReplyForm(false);
  };

  return (
    <div
      className={`comments-card${focused ? ' comments-card--focused' : ''} bg-white rounded-lg border overflow-hidden transition-shadow`}
      style={{
        borderColor: focused ? undefined : CARD_BORDER,
        outline: focused ? '2px solid #3b82f6' : undefined,
        outlineOffset: focused ? '-1px' : undefined,
        boxShadow: focused ? '0 1px 3px rgba(0,0,0,0.12)' : undefined,
      }}
      onClick={handleCardClick}
    >
      {/* Number badge — palette matches the inline .cm-comment-badge in the prose. */}
      {number != null && (
        <div
          className="px-3 pt-2 pb-0 flex items-center gap-2"
          style={{ fontSize: 11, color: focused ? '#2563eb' : '#9ca3af', fontWeight: 600 }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 18,
              height: 18,
              padding: '0 6px',
              borderRadius: 9,
              fontSize: 10,
              background: focused ? '#2563eb' : 'rgba(59, 130, 246, 0.15)',
              color: focused ? '#fff' : '#2563eb',
              border: focused ? '1px solid #2563eb' : '1px solid rgba(59, 130, 246, 0.3)',
              fontWeight: 700,
            }}
          >
            {number}
          </span>
        </div>
      )}

      {/* Root comment */}
      <div className="px-3 pt-2">
        <CommentRow
          message={root}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>

      {/* Replies */}
      {replies.length > 0 && (
        <div
          className="ml-3 mr-3 mb-2 mt-2 border-l-2 pl-3"
          style={{ borderColor: CARD_BORDER }}
        >
          {replies.map((reply) => (
            <div key={reply.id} className="py-1">
              <CommentRow
                message={reply}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            </div>
          ))}
        </div>
      )}

      {/* Reply button row */}
      <div className="px-3 pb-2 pt-1 flex items-center gap-3">
        {replies.length > 0 && (
          <span className="text-[11px] text-gray-500">
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </span>
        )}
        {!showReplyForm && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowReplyForm(true);
            }}
            className="text-[11px] text-blue-600 hover:text-blue-800 font-medium"
          >
            Reply
          </button>
        )}
      </div>

      {/* Reply form */}
      {showReplyForm && (
        <div
          className="mx-3 mb-3 border rounded-md overflow-hidden"
          style={{ borderColor: CARD_BORDER }}
        >
          <AddCommentForm
            onSubmit={handleReplySubmit}
            onCancel={() => setShowReplyForm(false)}
            placeholder="Write a reply..."
            submitLabel="Send"
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommentRow — renders a single comment with author, timestamp, content,
// and owner-only Edit / Delete actions.
// ---------------------------------------------------------------------------

interface CommentRowProps {
  message: MessageView;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
}

function CommentRow({ message, onEdit, onDelete }: CommentRowProps) {
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { author, body, timestamp, canModify } = message;

  if (editing) {
    return (
      <div
        className="border rounded-md overflow-hidden my-1"
        style={{ borderColor: CARD_BORDER }}
        onClick={(e) => e.stopPropagation()}
      >
        <AddCommentForm
          onSubmit={(content) => {
            onEdit(message, content);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          placeholder="Edit comment..."
          submitLabel="Save"
          initialValue={body}
        />
      </div>
    );
  }

  return (
    <div className="comment-item">
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className="text-[13px] font-semibold text-gray-900">{author}</span>
        {timestamp && (
          <span className="text-[11px] text-gray-400">{formatTimestamp(timestamp)}</span>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-gray-800 whitespace-pre-wrap">{body}</p>
      {canModify && (
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            className="text-[11px] text-gray-500 hover:text-blue-700"
          >
            Edit
          </button>
          <span className="text-gray-300">·</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteOpen(true);
            }}
            className="text-[11px] text-gray-500 hover:text-red-700"
          >
            Delete
          </button>
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title="Delete comment"
            description="Are you sure you want to delete this comment? This cannot be undone."
            onConfirm={() => {
              setDeleteOpen(false);
              onDelete(message);
            }}
            confirmLabel="Delete"
          />
        </div>
      )}
    </div>
  );
}
