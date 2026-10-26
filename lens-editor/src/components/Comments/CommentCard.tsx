import { useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { ThreadView, MessageView, ThreadKey, ThreadActions, ThreadAnchorInfo } from './types';
import { formatTimestamp } from '../../lib/format-timestamp';
import { AddCommentForm } from './AddCommentForm';
import { ConfirmDialog } from '../ConfirmDialog';
import { useMenuPopover } from '../Menu/useMenuPopover';

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
  /** Adds the current user's emoji reaction to a message, or takes it back
   *  (comments that keep reactions: the markdown editor's) */
  onReact?: (message: MessageView, emoji: string) => void;
}

/** The reactions on offer, as Notion's quick picks */
const REACTIONS = ['👍', '❤️', '😄', '🎉', '🙏', '👀', '✅', '🔥'];

/** Notion's comment icon: a speech bubble */
export function CommentIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 2.75h9a1.75 1.75 0 0 1 1.75 1.75v5.5A1.75 1.75 0 0 1 12.5 11.75H8.5l-3 2.5v-2.5h-2A1.75 1.75 0 0 1 1.75 10V4.5A1.75 1.75 0 0 1 3.5 2.75Z" />
    </svg>
  );
}

/** Notion's resolve icon: a tick */
function ResolveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-6.5" />
    </svg>
  );
}

/** Notion's add-reaction icon: a smiley with a plus */
function ReactIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.9 8.6A6 6 0 1 1 8 2a6 6 0 0 1 1.6.2" />
      <path d="M5.6 9.6a2.9 2.9 0 0 0 4.8 0" />
      <path d="M6 6.4v.1M10 6.4v.1" strokeWidth="1.8" />
      <path d="M13 1.6v3.6M11.2 3.4h3.6" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}

/** The ••• menu's icons, as Notion's: a pencil, a link, a bin */
function EditIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.6 2.9a1.5 1.5 0 0 1 2.1 2.1L5.4 12.3l-2.9.8.8-2.9Z" />
      <path d="m9.5 4 2.5 2.5" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
      <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.2 9.1a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 8.4a1 1 0 0 0 1 .95h4.3a1 1 0 0 0 1-.95l.6-8.4" />
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
  const { thread, number, focused, onFocus, onReply, onEdit, onDelete, actions, onReact } = props;
  const resolved = thread.resolved;
  const canResolve = !resolved && actions?.onResolve != null;
  const cardRef = useRef<HTMLDivElement>(null);

  // A click on the card opens it and puts the cursor in its reply bar, as in
  // Notion; a click on a button or in a field inside it stops before here
  const handleCardClick = () => {
    if (!focused) onFocus(thread.key);
    requestAnimationFrame(() => cardRef.current?.querySelector<HTMLTextAreaElement>('.lens-comment-replybar textarea')?.focus());
  };

  // Notion's discussion card (index.css): at rest a faint border, hovered a
  // grey background, open (focused) a shadow; both nudge it left. Messages
  // are rows with an avatar, joined by a thread line; each has a toolbar
  // while the pointer is over it. An open card has the reply bar.
  return (
    <div
      ref={cardRef}
      className={`comments-card lens-comment-card${focused ? ' comments-card--focused is-open' : ''}${resolved ? ' is-resolved' : ''}`}
      data-resolved={resolved ? '' : undefined}
      onClick={handleCardClick}
    >
      {/* Number, as on the comment's marker in the page (HTML pages) */}
      {(number != null || resolved) && (
        <div className="lens-comment-card-top">
          {number != null && (
            <span className="lens-comment-number" title={`Comment ${number}`}>
              <CommentIcon size={14} />
              {number}
            </span>
          )}
          {resolved && <span className="lens-comment-resolved">Resolved</span>}
        </div>
      )}
      {thread.anchor && <AnchorLine info={thread.anchor} thread={thread} actions={actions} />}

      <div className="lens-comment-thread">
        {[thread.root, ...thread.replies].map((message, index) => (
          <CommentRow
            key={message.id}
            message={message}
            onEdit={onEdit}
            onDelete={onDelete}
            onReact={onReact}
            onResolve={index === 0 && canResolve ? () => actions?.onResolve?.(thread) : undefined}
            onCopyLink={actions?.onCopyLink ? () => actions.onCopyLink!(thread) : undefined}
          />
        ))}
      </div>

      {resolved && (
        <div className="lens-comment-actions">
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
        </div>
      )}

      {/* Notion's reply bar, while the card is open */}
      {focused && (
        <div className="lens-comment-reply" onClick={(e) => e.stopPropagation()}>
          <AddCommentForm
            variant="bar"
            autoFocus={false}
            onSubmit={(content) => onReply(thread, content)}
            onCancel={() => (document.activeElement as HTMLElement | null)?.blur()}
            placeholder="Reply…"
            submitLabel="Send"
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommentRow — a message: avatar, author and time, the text and its
// reactions; and Notion's toolbar while the pointer is over it: react,
// resolve (on the thread's first message) and ••• (Edit for the author, Copy
// link, Delete for the author or (canDelete) anyone with edit access).
// ---------------------------------------------------------------------------

interface CommentRowProps {
  message: MessageView;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
  onReact?: (message: MessageView, emoji: string) => void;
  /** Resolves the thread: on its first message */
  onResolve?: () => void;
  onCopyLink?: () => void;
}

function CommentRow({ message, onEdit, onDelete, onReact, onResolve, onCopyLink }: CommentRowProps) {
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { open: pickerOpen, setOpen: setPickerOpen, toggle: togglePicker, position: pickerAt, buttonRef: pickerButton, menuRef: pickerMenu } = useMenuPopover(236);
  const { open: moreOpen, setOpen: setMoreOpen, toggle: toggleMore, position: moreAt, buttonRef: moreButton, menuRef: moreMenu } = useMenuPopover(200);

  const { author, body, timestamp, canModify } = message;
  const canDelete = message.canDelete ?? canModify;
  const hasMore = canModify || canDelete || onCopyLink != null;

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

  const menuItem = (label: string, icon: ReactElement, action: () => void) => (
    <button
      type="button"
      role="menuitem"
      className="lens-menu-item lens-menu-item-compact text-sm"
      onClick={stop(() => {
        setMoreOpen(false);
        action();
      })}
    >
      <span className="lens-menu-item-icon">{icon}</span>
      {label}
    </button>
  );

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
      {(message.reactions?.length ?? 0) > 0 && (
        <div className="lens-comment-reactions">
          {message.reactions!.map((r) => (
            <button
              key={r.emoji}
              type="button"
              className={`lens-reaction${r.mine ? ' is-mine' : ''}`}
              title={r.names.join(', ')}
              aria-pressed={r.mine}
              disabled={!onReact}
              onClick={stop(() => onReact?.(message, r.emoji))}
            >
              <span aria-hidden="true">{r.emoji}</span>
              <span>{r.names.length}</span>
            </button>
          ))}
        </div>
      )}

      {(onReact || onResolve || hasMore) && (
        <div className={`lens-comment-toolbar${pickerOpen || moreOpen ? ' is-active' : ''}`} onClick={(e) => e.stopPropagation()}>
          {onReact && (
            <button ref={pickerButton} type="button" className="lens-comment-tool-icon" title="Add reaction" aria-label="Add reaction" aria-expanded={pickerOpen} onClick={togglePicker}>
              <ReactIcon />
            </button>
          )}
          {onResolve && (
            <button type="button" className="lens-comment-tool-icon lens-comment-resolve" title="Resolve" aria-label="Resolve" onClick={onResolve}>
              <ResolveIcon />
            </button>
          )}
          {hasMore && (
            <button ref={moreButton} type="button" className="lens-comment-tool-icon" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded={moreOpen} onClick={toggleMore}>
              <MoreIcon />
            </button>
          )}
        </div>
      )}

      {pickerOpen && createPortal(
        <div ref={pickerMenu} role="menu" aria-label="Reactions" className="lens-popover lens-reaction-picker fixed z-[1200]" style={{ top: pickerAt.top, left: pickerAt.left }} onClick={(e) => e.stopPropagation()}>
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              aria-label={`React with ${emoji}`}
              className="lens-reaction-choice"
              onClick={() => {
                setPickerOpen(false);
                onReact?.(message, emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>,
        document.body,
      )}
      {moreOpen && createPortal(
        <div ref={moreMenu} role="menu" className="lens-popover fixed z-[1200] p-1" style={{ top: moreAt.top, left: moreAt.left, width: 200 }} onClick={(e) => e.stopPropagation()}>
          {canModify && menuItem('Edit', <EditIcon />, () => setEditing(true))}
          {onCopyLink && menuItem('Copy link', <LinkIcon />, onCopyLink)}
          {canDelete && menuItem('Delete', <DeleteIcon />, () => setDeleteOpen(true))}
        </div>,
        document.body,
      )}
      {canDelete && (
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
      )}
    </div>
  );
}
