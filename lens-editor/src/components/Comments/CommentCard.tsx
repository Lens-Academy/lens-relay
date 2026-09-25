import { useState, type ReactElement } from 'react';
import type { ThreadView, MessageView, ThreadKey, ThreadActions, ThreadAnchorInfo } from './types';
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
  /** Resolve / re-attach actions, for comment sources that support them. */
  actions?: ThreadActions;
}

const CARD_BORDER = '#e8e5df';

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stop(fn: () => void) {
  return (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
}

const LINK_BUTTON = 'text-[11px] font-medium text-blue-600 hover:text-blue-800';

/** What the thread points at in the page, and whether it is still found there. */
function AnchorLine({ info, thread, actions }: { info: ThreadAnchorInfo; thread: ThreadView; actions?: ThreadActions }) {
  const status = {
    anchored: null,
    locating: null,
    hidden: { label: 'In a hidden part of the page', cls: 'bg-gray-100 text-gray-600' },
    guessed: { label: 'Moved? Check the spot', cls: 'bg-orange-100 text-orange-800' },
    orphaned: { label: 'Not found on the page', cls: 'bg-red-100 text-red-700' },
  }[info.state];
  return (
    <div className="px-3 pt-2" data-anchor-state={info.state}>
      <p
        className={`border-l-2 pl-2 text-[12px] italic leading-snug ${info.state === 'orphaned' ? 'text-gray-400 line-through decoration-gray-300' : 'text-gray-600'}`}
        style={{ borderColor: info.state === 'guessed' ? '#fb923c' : info.state === 'orphaned' ? '#fca5a5' : '#fcd34d' }}
        title={info.target}
      >
        {clipText(info.target, 140)}
      </p>
      {status && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${status.cls}`}>{status.label}</span>
          {info.state === 'guessed' && actions?.onConfirmAnchor && (
            <button type="button" className={LINK_BUTTON} onClick={stop(() => actions.onConfirmAnchor!(thread))}>
              Looks right
            </button>
          )}
          {(info.state === 'guessed' || info.state === 'orphaned') && actions?.onReattach && (
            <button type="button" className={LINK_BUTTON} onClick={stop(() => actions.onReattach!(thread))}>
              Re-attach
            </button>
          )}
        </div>
      )}
      {info.state === 'guessed' && info.currentText && info.currentText !== info.target && (
        <p className="mt-1 text-[11px] leading-snug text-gray-500">
          Now on: “{clipText(info.currentText, 120)}”
        </p>
      )}
    </div>
  );
}

export function CommentCard(props: CommentCardProps): ReactElement {
  const { thread, number, focused, onFocus, onReply, onEdit, onDelete, actions } = props;
  const resolved = thread.resolved;

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
      className={`comments-card${focused ? ' comments-card--focused' : ''}${resolved ? ' opacity-75' : ''} bg-white rounded-lg border overflow-hidden transition-shadow`}
      data-resolved={resolved ? '' : undefined}
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

      {resolved && (
        <div className="px-3 pt-2">
          <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-800">Resolved</span>
        </div>
      )}
      {thread.anchor && <AnchorLine info={thread.anchor} thread={thread} actions={actions} />}

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
        {!resolved && actions?.onResolve && (
          <button type="button" className={LINK_BUTTON} onClick={stop(() => actions.onResolve!(thread))}>
            Resolve
          </button>
        )}
        {resolved && (
          <span className="text-[11px] text-gray-500">
            Resolved by {resolved.by}
            {actions?.onReopen && (
              <>
                {' · '}
                <button type="button" className={LINK_BUTTON} onClick={stop(() => actions.onReopen!(thread))}>
                  Reopen
                </button>
              </>
            )}
          </span>
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
