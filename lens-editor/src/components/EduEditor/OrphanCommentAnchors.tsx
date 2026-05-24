interface OrphanCommentAnchor {
  /** Absolute Y.Text offset of the comment marker. */
  absFrom: number;
  /** Comment number (1-indexed by document order); omitted if unknown. */
  badgeNumber?: number;
}

interface OrphanCommentAnchorsProps {
  anchors: OrphanCommentAnchor[];
  /** Called when a badge is clicked, with the comment's absolute offset. */
  onCommentClick?: (absFrom: number) => void;
}

/**
 * Visible numbered badges for comments that fall outside any rendered field
 * value (heading lines, blank lines, sections with no field). Sits at the
 * top of the section's rendered block; provides both a click target for
 * focusing the thread AND a `data-comment-from` element so the
 * CommentsLayer DOM-fallback resolver can place a card here.
 */
export function OrphanCommentAnchors({ anchors, onCommentClick }: OrphanCommentAnchorsProps) {
  if (anchors.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mb-1">
      {anchors.map(({ absFrom, badgeNumber }) => (
        <span
          key={absFrom}
          data-comment-from={absFrom}
          className="cm-comment-anchor inline-flex items-center justify-center align-baseline px-1.5 min-w-4.5 h-4.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-semibold cursor-pointer select-none hover:bg-blue-200"
          title="Comment on heading"
          onClick={(e) => {
            e.stopPropagation();
            onCommentClick?.(absFrom);
          }}
        >
          {badgeNumber ?? '\u{1F4AC}'}
        </span>
      ))}
    </div>
  );
}
