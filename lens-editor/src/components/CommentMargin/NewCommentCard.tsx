import { forwardRef } from 'react';
import { AddCommentForm } from '../CommentsPanel/AddCommentForm';

interface NewCommentCardProps {
  onSubmit: (content: string) => void;
  onCancel: () => void;
  style?: React.CSSProperties;
}

export const NewCommentCard = forwardRef<HTMLDivElement, NewCommentCardProps>(
  function NewCommentCard({ onSubmit, onCancel, style }, ref) {
    return (
      <div
        ref={ref}
        className="comment-card comment-card-new border border-blue-300 rounded-lg bg-white shadow-sm"
        style={style}
      >
        <AddCommentForm
          onSubmit={onSubmit}
          onCancel={onCancel}
          placeholder="Add a comment..."
          submitLabel="Comment"
        />
      </div>
    );
  }
);
