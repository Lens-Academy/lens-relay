import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  renderHeadingWithCriticMarkup,
  type CommentBadgeInfo,
} from '../../../../lib/criticmarkup-render';
import type { CriticMarkupRange } from '../../../../lib/criticmarkup-parser';

interface HeadingRendererProps {
  label: string;
  /** Font size in px. Defaults to 18. Use 22 for page-level headings. */
  fontSize?: number;
  onStartEdit: () => void;
  /**
   * When true, criticmarkup in the heading source is rendered with inline
   * styling. Default false preserves existing call sites.
   */
  enableCriticMarkup?: boolean;
  onClickCriticRange?: (range: CriticMarkupRange) => void;
  /** Pre-computed badge info keyed by LOCAL `range.from` (positions in
   *  `label`). Authored by ContentPanel from a document-wide global map. */
  commentBadgeMap?: Map<number, CommentBadgeInfo>;
}

export function HeadingRenderer({
  label,
  fontSize = 18,
  onStartEdit,
  enableCriticMarkup = false,
  onClickCriticRange,
  commentBadgeMap,
}: HeadingRendererProps) {
  const handleClickRange = onClickCriticRange
    ? (range: CriticMarkupRange) => onClickCriticRange(range)
    : undefined;

  const onContainerClick = (e: ReactMouseEvent) => {
    if (handleClickRange) {
      const target = e.target as HTMLElement;
      if (target.closest('.cm-comment-anchor')) return;
    }
    onStartEdit();
  };

  return (
    <div
      className="mb-4 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
      onClick={onContainerClick}
    >
      <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        click to edit
      </div>
      <div style={{ fontFamily: "'Newsreader', serif", fontSize: `${fontSize}px`, fontWeight: 600, color: '#1a1a1a' }}>
        {enableCriticMarkup
          ? renderHeadingWithCriticMarkup(label, {
              onClickRange: handleClickRange,
              commentBadgeMap,
            })
          : label}
      </div>
    </div>
  );
}
