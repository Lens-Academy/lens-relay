interface OrphanCommentAnchorsProps {
  /** Absolute Y.Text offsets of comments to anchor. */
  offsets: number[];
}

/**
 * Renders zero-size invisible elements with `data-comment-from` set to each
 * offset. The comment-margin layer scans the DOM for these attributes
 * (`resolveAnchorYFromDOM`) and uses their screen-y to place the card —
 * giving comments outside any rendered field a real anchor near where their
 * containing section starts.
 */
export function OrphanCommentAnchors({ offsets }: OrphanCommentAnchorsProps) {
  if (offsets.length === 0) return null;
  return (
    <>
      {offsets.map((offset) => (
        <span
          key={offset}
          data-comment-from={offset}
          style={{ display: 'block', height: 0, width: 0 }}
          aria-hidden
        />
      ))}
    </>
  );
}
