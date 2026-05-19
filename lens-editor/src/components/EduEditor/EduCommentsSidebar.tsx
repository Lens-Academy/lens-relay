/**
 * Comments sidebar for the EduEditor — toggleable right-hand panel.
 *
 * Independent of CodeMirror EditorView: reads comment threads directly
 * from the active Y.Text and writes back via Y.Doc transactions. The
 * markdown editor's CommentsPanel is left untouched.
 *
 * Visual language matches the EduEditor's main panel: the warm off-white
 * `#faf8f3` background, white cards with `#e8e5df` borders, small uppercase
 * section labels, and DM Sans body type. Each thread is rendered as one
 * card matching the section list cards in the left tree.
 */

import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useCommentsFromText } from '../CommentsPanel/useComments';
import { AddCommentForm } from '../CommentsPanel/AddCommentForm';
import { formatTimestamp } from '../../lib/format-timestamp';
import {
  insertCommentInYText,
  replyInYText,
  deleteRangeInYText,
  editRangeContentInYText,
  isOwnRange,
} from '../../lib/ytext-comment-ops';
import type { CommentThread, CriticMarkupRange } from '../../lib/criticmarkup-parser';
import { decodeCommentContent } from '../../lib/criticmarkup-parser';

interface EduCommentsSidebarProps {
  /** Compound doc id (RELAY_ID-docUuid) of the doc the user is currently viewing,
   *  or null when nothing is selected. */
  docId: string | null;
  /** Optional focus signal — when set, the sidebar scrolls/highlights the matching
   *  thread (matched by source position of the root comment). */
  focusedRangeFrom?: number | null;
  /** Optional click-to-add: when this counter increments, the sidebar opens its
   *  add-comment form. Used by toolbar/shortcut entry points. */
  addCommentTrigger?: number;
  /** Position in Y.Text at which the next "Add Comment" should be inserted.
   *  When null, a no-op (the sidebar shows the form but submission requires
   *  a position). */
  insertAtPos?: number | null;
  /** Absolute Y.Text position of the topmost comment marker currently visible
   *  in the main content scroll area. Drives a gentle (block: 'nearest')
   *  auto-scroll of the sidebar so the matching thread is always at least
   *  partially in view. Does NOT change the focused-thread highlight. */
  visibleCommentFrom?: number | null;
}

const SIDEBAR_BG = '#faf8f3';
const CARD_BORDER = '#e8e5df';
const FONT_BODY = "'DM Sans', sans-serif";

export function EduCommentsSidebar({
  docId,
  focusedRangeFrom,
  addCommentTrigger,
  insertAtPos,
  visibleCommentFrom,
}: EduCommentsSidebarProps) {
  const { getOrConnect } = useDocConnection();
  const [ytext, setYtext] = useState<Y.Text | null>(null);
  const [text, setText] = useState<string>('');
  const [showAddForm, setShowAddForm] = useState(false);

  // Connect / subscribe to the active doc's "contents" Y.Text. Independent
  // of ContentPanel's own subscription — getOrConnect is idempotent.
  useEffect(() => {
    if (!docId) {
      setYtext(null);
      setText('');
      return;
    }

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const { doc } = await getOrConnect(docId);
      if (cancelled) return;
      const yt = doc.getText('contents');
      const update = () => setText(yt.toString());
      setYtext(yt);
      update();
      yt.observe(update);
      cleanup = () => yt.unobserve(update);
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [docId, getOrConnect]);

  // External "open add form" trigger
  useEffect(() => {
    if (addCommentTrigger && addCommentTrigger > 0) {
      setShowAddForm(true);
    }
  }, [addCommentTrigger]);

  const threads = useCommentsFromText(text);

  const handleAddComment = (content: string) => {
    if (!ytext || insertAtPos == null) return;
    insertCommentInYText(ytext, content, insertAtPos);
    setShowAddForm(false);
  };

  const canAddNow = ytext != null && insertAtPos != null;

  return (
    <div
      className="edu-comments-sidebar flex flex-col h-full"
      style={{ background: SIDEBAR_BG, fontFamily: FONT_BODY }}
    >
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: CARD_BORDER }}
      >
        <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold">
          Comments
        </div>
        <button
          type="button"
          disabled={!ytext}
          onClick={() => setShowAddForm(true)}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
            canAddNow
              ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200'
              : 'bg-white text-gray-400 cursor-not-allowed border border-gray-200'
          }`}
          title={
            canAddNow
              ? 'Add comment at current cursor position'
              : 'Click into a section first, then add a comment'
          }
        >
          <span className="text-base leading-none">+</span>
          <span>Add</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {showAddForm && ytext && (
          <div
            className="rounded-lg bg-white border overflow-hidden"
            style={{ borderColor: CARD_BORDER }}
          >
            <AddCommentForm
              onSubmit={handleAddComment}
              onCancel={() => setShowAddForm(false)}
              placeholder={
                canAddNow
                  ? 'Add a comment...'
                  : 'Place a cursor in a section first, then write your comment...'
              }
            />
          </div>
        )}

        {!docId && (
          <div className="text-sm text-gray-500 px-2 py-6 text-center">
            No document selected
          </div>
        )}
        {docId && threads.length === 0 && !showAddForm && (
          <div className="text-sm text-gray-500 px-2 py-6 text-center">
            No comments yet
          </div>
        )}

        {threads.map((thread, threadIndex) => (
          <CommentThreadCard
            key={`thread-${thread.from}-${threadIndex}`}
            thread={thread}
            ytext={ytext}
            badgeNumber={threadIndex + 1}
            focused={focusedRangeFrom === thread.comments[0]?.from}
            spotlit={visibleCommentFrom === thread.comments[0]?.from}
          />
        ))}
      </div>
    </div>
  );
}

interface CommentThreadCardProps {
  thread: CommentThread;
  ytext: Y.Text | null;
  badgeNumber: number;
  /** True when the user clicked the matching inline badge in the prose —
   *  fires a deliberate scroll-to-center with a blue outline. */
  focused: boolean;
  /** True when this thread is the topmost comment currently visible in the
   *  main content area (scroll-spy). Triggers a gentle "scroll into view if
   *  needed" pass without changing the visual focus styling. */
  spotlit: boolean;
}

function CommentThreadCard({
  thread,
  ytext,
  badgeNumber,
  focused,
  spotlit,
}: CommentThreadCardProps) {
  const [showReplyForm, setShowReplyForm] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const root = thread.comments[0];
  const replies = thread.comments.slice(1);

  const handleReply = (content: string) => {
    if (!ytext) return;
    replyInYText(ytext, content, thread.to);
    setShowReplyForm(false);
  };

  // Deliberate focus (user clicked the inline badge) — scroll to center with
  // a slight delay so the sidebar's open animation has time to settle.
  useEffect(() => {
    if (!focused || !containerRef.current) return;
    const el = containerRef.current;
    const tick = window.setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    return () => window.clearTimeout(tick);
  }, [focused, thread.from]);

  // Scroll-spy follow — gentler than the focused path: `block: 'nearest'`
  // is a no-op when the card is already visible, otherwise nudges it just
  // into view. Skipped when this thread is already the user-focused one so
  // the two effects don't fight.
  useEffect(() => {
    if (!spotlit || focused || !containerRef.current) return;
    const el = containerRef.current;
    const tick = window.setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 80);
    return () => window.clearTimeout(tick);
  }, [spotlit, focused, thread.from]);

  return (
    <div
      ref={containerRef}
      className={`comment-thread bg-white rounded-lg border overflow-hidden transition-shadow ${
        focused ? 'outline-2 outline-solid outline-blue-500 -outline-offset-1 shadow-sm' : ''
      }`}
      style={{ borderColor: focused ? undefined : CARD_BORDER }}
      data-thread-from={thread.from}
    >
      <div className="flex items-start gap-2 px-3 pt-3">
        <span
          className="mt-1 inline-flex items-center justify-center px-2 min-w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-[11px] font-semibold select-none shrink-0"
          aria-label={`Comment ${badgeNumber}`}
        >
          {badgeNumber}
        </span>
        <div className="flex-1 min-w-0">
          <CommentRow comment={root} ytext={ytext} />
        </div>
      </div>

      {replies.length > 0 && (
        <div
          className="ml-9 mr-3 mb-2 mt-1 border-l-2 pl-3"
          style={{ borderColor: CARD_BORDER }}
        >
          {replies.map((reply, idx) => (
            <div key={`reply-${reply.from}-${idx}`} className="py-1">
              <CommentRow comment={reply} ytext={ytext} />
            </div>
          ))}
        </div>
      )}

      <div className="px-3 pb-2 pt-1 flex items-center gap-3 ml-9">
        {replies.length > 0 && (
          <span className="text-[11px] text-gray-500">
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </span>
        )}
        {!showReplyForm && (
          <button
            onClick={() => setShowReplyForm(true)}
            className="text-[11px] text-blue-600 hover:text-blue-800 font-medium"
          >
            Reply
          </button>
        )}
      </div>

      {showReplyForm && (
        <div
          className="ml-9 mr-3 mb-3 border rounded-md overflow-hidden"
          style={{ borderColor: CARD_BORDER }}
        >
          <AddCommentForm
            onSubmit={handleReply}
            onCancel={() => setShowReplyForm(false)}
            placeholder="Write a reply..."
            submitLabel="Reply"
          />
        </div>
      )}
    </div>
  );
}

function CommentRow({ comment, ytext }: { comment: CriticMarkupRange; ytext: Y.Text | null }) {
  const [editing, setEditing] = useState(false);
  const author = comment.metadata?.author || 'Anonymous';
  const timestamp = comment.metadata?.timestamp;
  const own = isOwnRange(comment);
  const display = decodeCommentContent(comment.content);

  if (editing) {
    return (
      <div
        className="border rounded-md overflow-hidden my-1"
        style={{ borderColor: CARD_BORDER }}
      >
        <AddCommentForm
          onSubmit={(content) => {
            if (!ytext) return;
            editRangeContentInYText(ytext, comment, content);
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
    <div className="comment-item">
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className="text-[13px] font-semibold text-gray-900">{author}</span>
        {timestamp && (
          <span className="text-[11px] text-gray-400">{formatTimestamp(timestamp)}</span>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-gray-800 whitespace-pre-wrap">{display}</p>
      {own && (
        <div className="mt-1 flex items-center gap-2">
          <button
            onClick={() => setEditing(true)}
            className="text-[11px] text-gray-500 hover:text-blue-700"
          >
            Edit
          </button>
          <span className="text-gray-300">·</span>
          <button
            onClick={() => {
              if (!ytext) return;
              if (!confirm('Delete this comment?')) return;
              deleteRangeInYText(ytext, comment);
            }}
            className="text-[11px] text-gray-500 hover:text-red-700"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
