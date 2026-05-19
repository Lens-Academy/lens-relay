import { useState, forwardRef } from 'react';
import type { CommentThread } from '../../lib/criticmarkup-parser';
import { decodeCommentContent } from '../../lib/criticmarkup-parser';
import { AddCommentForm } from '../CommentsPanel/AddCommentForm';
import { formatTimestamp } from '../../lib/format-timestamp';

interface CommentCardProps {
  thread: CommentThread;
  badgeNumber: number;
  focused: boolean;
  onFocus: () => void;
  onReply: (content: string) => void;
  onScrollToComment: () => void;
  style?: React.CSSProperties;
}

export const CommentCard = forwardRef<HTMLDivElement, CommentCardProps>(
  function CommentCard({ thread, badgeNumber, focused, onFocus, onReply, onScrollToComment, style }, ref) {
    const [showReplyForm, setShowReplyForm] = useState(false);
    const rootComment = thread.comments[0];
    const replies = thread.comments.slice(1);
    const replyCount = replies.length;
    const author = rootComment.metadata?.author || 'Anonymous';
    const timestamp = rootComment.metadata?.timestamp;
    const rootText = decodeCommentContent(rootComment.content);

    const handleReply = (content: string) => {
      onReply(content);
      setShowReplyForm(false);
    };

    return (
      <div
        ref={ref}
        className={`comment-card border border-gray-200 rounded-lg bg-white shadow-sm ${focused ? 'comment-card-focused' : ''}`}
        style={style}
        onClick={() => {
          if (!focused) onScrollToComment();
          onFocus();
        }}
      >
        <div className="px-3 pt-2 pb-2">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-semibold ${
                focused
                  ? 'bg-blue-600 text-white'
                  : 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
              }`}
            >
              {badgeNumber}
            </span>
            <span className="text-sm font-medium text-gray-900">{author}</span>
            {timestamp && (
              <span className="text-[11px] text-gray-400">{formatTimestamp(timestamp)}</span>
            )}
            {!showReplyForm && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowReplyForm(true);
                }}
                className="ml-auto text-[11px] text-blue-600 hover:text-blue-800 font-medium"
              >
                Reply
              </button>
            )}
          </div>
          <p className="text-sm text-gray-700 whitespace-pre-wrap leading-snug">{rootText}</p>
        </div>

        {/* Replies — only render the divider + container when there's at least one. */}
        {replyCount > 0 && (
          <div className="px-3 pb-2 pt-1 border-t border-gray-100">
            <div className="border-l-2 border-gray-100 pl-3 ml-1 space-y-2">
              {replies.map((reply, index) => (
                <div key={`reply-${reply.from}-${index}`}>
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="text-[12px] font-medium text-gray-800">{reply.metadata?.author || 'Anonymous'}</span>
                    {reply.metadata?.timestamp && (
                      <span className="text-[10px] text-gray-400">{formatTimestamp(reply.metadata.timestamp)}</span>
                    )}
                  </div>
                  <p className="text-[13px] text-gray-700 whitespace-pre-wrap leading-snug">
                    {decodeCommentContent(reply.content)}
                  </p>
                </div>
              ))}
            </div>
            <div className="mt-1.5 text-[11px] text-gray-500">
              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </div>
          </div>
        )}

        {showReplyForm && (
          <div className="border-t border-gray-100">
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
);
