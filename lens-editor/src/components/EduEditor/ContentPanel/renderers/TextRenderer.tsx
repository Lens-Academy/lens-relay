import type { MouseEvent as ReactMouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import {
  renderMarkdownWithCriticMarkup,
  type CommentBadgeInfo,
} from '../../../../lib/criticmarkup-render';
import type { CriticMarkupRange } from '../../../../lib/criticmarkup-parser';

/** Preserve multiple blank lines by inserting non-breaking space paragraphs. */
function preserveBlankLines(text: string): string {
  return text.replace(/\n{2,}/g, (match) => {
    const extras = match.length - 1;
    return '\n\n' + ' \n\n'.repeat(extras);
  });
}

interface TextRendererProps {
  content: string;
  onStartEdit: () => void;
  enableCriticMarkup?: boolean;
  onClickCriticRange?: (range: CriticMarkupRange) => void;
  /** Fires for comment-marker clicks with the absolute Y.Text offset. */
  onCommentClick?: (absFrom: number) => void;
  commentBadgeMap?: Map<number, CommentBadgeInfo>;
}

export function TextRenderer({
  content,
  onStartEdit,
  enableCriticMarkup = false,
  onClickCriticRange,
  onCommentClick,
  commentBadgeMap,
}: TextRendererProps) {
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
      className="mb-7 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded-md"
      onClick={onContainerClick}
    >
      <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        click to edit
      </div>
      <div
        className="text-[13px] leading-[1.5] text-gray-900 prose prose-sm max-w-none"
        style={{ fontFamily: "'DM Sans', sans-serif" }}
      >
        {enableCriticMarkup
          ? renderMarkdownWithCriticMarkup(content, {
              onClickRange: handleClickRange,
              onMarkerClick: onCommentClick,
              commentBadgeMap,
            })
          : <ReactMarkdown remarkPlugins={[remarkBreaks]}>{preserveBlankLines(content)}</ReactMarkdown>}
      </div>
    </div>
  );
}
