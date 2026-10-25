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

/** Notion's comment icon: a speech bubble */
export function CommentIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 2.75h9a1.75 1.75 0 0 1 1.75 1.75v5.5A1.75 1.75 0 0 1 12.5 11.75H8.5l-3 2.5v-2.5h-2A1.75 1.75 0 0 1 1.75 10V4.5A1.75 1.75 0 0 1 3.5 2.75Z" />
    </svg>
  );
}

/** Notion's resolve icon: a tick in a circle */
function ResolveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="m5.25 8.25 1.9 1.9 3.6-3.9" />
    </svg>
  );
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stop(fn: () => void) {
  return (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
}

const LINK_BUTTON = 'lens-comment-action';

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
  const canResolve = !resolved && actions?.onResolve != null;

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

  // Notion's discussion card (index.css): at rest a faint border, hovered a
  // grey background, open (focused) a shadow; both nudge it left. Messages
  // are rows with an avatar, joined by a thread line.
  return (
    <div
      className={`comments-card lens-comment-card${focused ? ' comments-card--focused is-open' : ''}${resolved ? ' is-resolved' : ''}`}
      data-resolved={resolved ? '' : undefined}
      onClick={handleCardClick}
    >
      {/* Number, as on the comment's marker in the text, and Notion's
          resolve tick at the top right */}
      {(number != null || resolved || canResolve) && (
        <div className="lens-comment-card-top">
          {number != null && (
            <span className="lens-comment-number" title={`Comment ${number}`}>
              <CommentIcon size={14} />
              {number}
            </span>
          )}
          {resolved && <span className="lens-comment-resolved">Resolved</span>}
          {canResolve && (
            <button
              type="button"
              className="lens-comment-resolve"
              title="Resolve"
              aria-label="Resolve"
              onClick={stop(() => actions?.onResolve?.(thread))}
            >
              <ResolveIcon />
            </button>
          )}
        </div>
      )}
      {thread.anchor && <AnchorLine info={thread.anchor} thread={thread} actions={actions} />}

      <div className="lens-comment-thread">
        <CommentRow
          message={root}
          onEdit={onEdit}
          onDelete={onDelete}
        />
        {replies.map((reply) => (
          <CommentRow
            key={reply.id}
            message={reply}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>

      {/* Actions row */}
      <div className="lens-comment-actions">
        {!showReplyForm && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowReplyForm(true);
            }}
            className="lens-comment-action"
          >
            Reply
          </button>
        )}
        {resolved && (
          <span className="lens-comment-note">
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

      {/* Reply box */}
      {showReplyForm && (
        <div className="lens-comment-reply" onClick={(e) => e.stopPropagation()}>
          <AddCommentForm
            onSubmit={handleReplySubmit}
            onCancel={() => setShowReplyForm(false)}
            placeholder="Reply…"
            submitLabel="Send"
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommentRow — renders a single comment with author, timestamp, content,
// author-only Edit, and Delete for the author or (canDelete) anyone with edit access.
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
  const canDelete = message.canDelete ?? canModify;

  if (editing) {
    return (
      <div className="lens-comment-edit" onClick={(e) => e.stopPropagation()}>
        <AddCommentForm
          onSubmit={(content) => {
            onEdit(message, content);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          placeholder="Edit comment…"
          submitLabel="Save"
          initialValue={body}
        />
      </div>
    );
  }

  return (
    <div className="comment-item lens-comment-row">
      {/* Notion's avatar for someone without a photo: their initial */}
      <span className="lens-comment-avatar" aria-hidden="true">{author.trim().charAt(0).toUpperCase() || '?'}</span>
      <div className="lens-comment-head">
        <span className="lens-comment-author">{author}</span>
        {timestamp && (
          <span className="lens-comment-time">{formatTimestamp(timestamp)}</span>
        )}
      </div>
      <p className="lens-comment-body">{body}</p>
      {(canModify || canDelete) && (
        <div className="lens-comment-tools">
          {canModify && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
              className="lens-comment-tool"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteOpen(true);
            }}
            className="lens-comment-tool"
          >
            Delete
          </button>
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title="Delete comment"
            description={
              canModify
                ? 'Are you sure you want to delete this comment? This cannot be undone.'
                : `Delete ${author}'s comment for everyone? Do this once it is addressed. This cannot be undone.`
            }
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
