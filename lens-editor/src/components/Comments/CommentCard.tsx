/**
 * CommentCard — renders a single thread (root comment + replies) at an
 * absolute vertical position in the margin.
 *
 * No layout logic lives here: the caller passes `top` and this component
 * simply renders at that position. The CommentsLayer container owns layout.
 */

import { useState, type ReactElement } from 'react';
import type { CommentThread, CriticMarkupRange } from '../../lib/criticmarkup-parser';
import { decodeCommentContent } from '../../lib/criticmarkup-parser';
import { formatTimestamp } from '../../lib/format-timestamp';
import { AddCommentForm } from './AddCommentForm';
import { ConfirmDialog } from '../ConfirmDialog';

export interface CommentCardProps {
  thread: CommentThread;
  top: number;
  /** 1-indexed comment number, matching the inline badge in the prose. */
  number?: number;
  focused: boolean;
  currentUserName: string;
  onFocus: (threadFrom: number) => void;
  /** Reply to the thread; threadEndPos is thread.to. */
  onReply: (threadEndPos: number, content: string) => void;
  /** Edit comment at thread.comments[rangeIndex]. */
  onEdit: (rangeIndex: number, newContent: string) => void;
  /** Delete comment at thread.comments[rangeIndex]. */
  onDelete: (rangeIndex: number) => void;
}

const CARD_BORDER = '#e8e5df';

export function CommentCard(props: CommentCardProps): ReactElement {
  const { thread, top, number, focused, currentUserName, onFocus, onReply, onEdit, onDelete } = props;

  const [showReplyForm, setShowReplyForm] = useState(false);

  const root = thread.comments[0];
  const replies = thread.comments.slice(1);

  const handleCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only fire onFocus when clicking directly on the card, not on interactive elements.
    if (e.target === e.currentTarget) {
      onFocus(thread.from);
    }
  };

  const handleReplySubmit = (content: string) => {
    onReply(thread.to, content);
    setShowReplyForm(false);
  };

  return (
    <div
      className={`comments-card${focused ? ' comments-card--focused' : ''} bg-white rounded-lg border overflow-hidden transition-shadow`}
      style={{
        // Positioning is owned by the parent (CommentsLayer wraps each card in
        // an absolutely-positioned div). The card flows normally inside its
        // wrapper so the wrapper auto-sizes to the card's measured height —
        // critical for ResizeObserver-driven re-layout.
        borderColor: focused ? undefined : CARD_BORDER,
        outline: focused ? '2px solid #3b82f6' : undefined,
        outlineOffset: focused ? '-1px' : undefined,
        boxShadow: focused ? '0 1px 3px rgba(0,0,0,0.12)' : undefined,
      }}
      data-thread-from={thread.from}
      onClick={handleCardClick}
    >
      {/* Number badge (matches the inline numbered superscript in the prose) */}
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
              background: focused ? '#2563eb' : '#fef3c7',
              color: focused ? '#fff' : '#92400e',
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
          comment={root}
          rangeIndex={0}
          currentUserName={currentUserName}
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
          {replies.map((reply, idx) => (
            <div key={`reply-${reply.from}-${idx}`} className="py-1">
              <CommentRow
                comment={reply}
                rangeIndex={idx + 1}
                currentUserName={currentUserName}
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
            submitLabel="Reply"
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
  comment: CriticMarkupRange;
  rangeIndex: number;
  currentUserName: string;
  onEdit: (rangeIndex: number, newContent: string) => void;
  onDelete: (rangeIndex: number) => void;
}

function CommentRow({ comment, rangeIndex, currentUserName, onEdit, onDelete }: CommentRowProps) {
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const author = comment.metadata?.author || 'Anonymous';
  const timestamp = comment.metadata?.timestamp;
  const isOwn = comment.metadata?.author === currentUserName;
  const display = decodeCommentContent(comment.content);

  if (editing) {
    return (
      <div
        className="border rounded-md overflow-hidden my-1"
        style={{ borderColor: CARD_BORDER }}
        onClick={(e) => e.stopPropagation()}
      >
        <AddCommentForm
          onSubmit={(content) => {
            onEdit(rangeIndex, content);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          placeholder="Edit comment..."
          submitLabel="Save"
          initialValue={display}
        />
      </div>
    );
  }

  return (
    <div className="comment-item" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className="text-[13px] font-semibold text-gray-900">{author}</span>
        {timestamp && (
          <span className="text-[11px] text-gray-400">{formatTimestamp(timestamp)}</span>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-gray-800 whitespace-pre-wrap">{display}</p>
      {isOwn && (
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
              onDelete(rangeIndex);
            }}
            confirmLabel="Delete"
          />
        </div>
      )}
    </div>
  );
}
