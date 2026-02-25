import { useState, forwardRef } from 'react';
import type { CommentThread } from '../../lib/criticmarkup-parser';
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
        <div className="px-3 py-2">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-xs font-semibold border ${focused ? 'bg-blue-700 text-white border-blue-700' : 'bg-blue-50 text-blue-600 border-blue-200'}`}>
              {badgeNumber}
            </span>
            <span className="text-sm font-medium text-gray-900">{author}</span>
            {timestamp && (
              <span className="text-xs text-gray-400">{formatTimestamp(timestamp)}</span>
            )}
          </div>
          <p className="text-sm text-gray-700">{rootComment.content}</p>
        </div>

        {/* Replies */}
        {replies.map((reply, index) => (
          <div key={`reply-${reply.from}-${index}`} className="px-3 py-1 ml-[26px] border-t border-gray-100">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs font-medium text-gray-700">{reply.metadata?.author || 'Anonymous'}</span>
              {reply.metadata?.timestamp && (
                <span className="text-xs text-gray-400">{formatTimestamp(reply.metadata.timestamp)}</span>
              )}
            </div>
            <p className="text-sm text-gray-600">{reply.content}</p>
          </div>
        ))}

        {/* Footer: reply count + reply button */}
        <div className="px-3 py-1.5 flex items-center gap-2 border-t border-gray-100">
          {replyCount > 0 && (
            <span className="text-xs text-gray-500">
              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowReplyForm(true);
            }}
            className="text-xs text-blue-600 hover:text-blue-800"
          >
            Reply
          </button>
        </div>

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
