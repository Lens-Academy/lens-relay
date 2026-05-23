import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  renderMarkdownWithCriticMarkup,
  type CommentBadgeInfo,
} from '../../../../lib/criticmarkup-render';
import type { CriticMarkupRange } from '../../../../lib/criticmarkup-parser';

interface QuestionRendererProps {
  content: string;
  assessmentInstructions?: string;
  enforceVoice?: string;
  maxChars?: string;
  onStartEdit: () => void;
  /** When true, criticmarkup syntax in `content` and `assessmentInstructions`
   *  is rendered with inline styling. Defaults off so existing call sites
   *  keep the previous react-markdown rendering. */
  enableCriticMarkup?: boolean;
  /** Click handler for inline criticmarkup spans — typically a comment
   *  marker — so EduEditor can focus the matching thread in the sidebar. */
  onClickCriticRange?: (range: CriticMarkupRange) => void;
  /** Badge map keyed by LOCAL positions inside the `content` field. */
  contentBadgeMap?: Map<number, CommentBadgeInfo>;
  /** Badge map keyed by LOCAL positions inside the `assessmentInstructions`
   *  field. */
  assessmentBadgeMap?: Map<number, CommentBadgeInfo>;
}

export function QuestionRenderer({
  content,
  assessmentInstructions,
  enforceVoice,
  maxChars,
  onStartEdit,
  enableCriticMarkup = false,
  onClickCriticRange,
  contentBadgeMap,
  assessmentBadgeMap,
}: QuestionRendererProps) {
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
      className="mb-7 p-4 bg-white rounded-lg border border-[#e8e5df] relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1"
      onClick={onContainerClick}
    >
      <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        click to edit
      </div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-orange-700 font-semibold">Question</span>
        {enforceVoice === 'true' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-600">voice</span>
        )}
        {maxChars && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">max {maxChars} chars</span>
        )}
      </div>
      <div className="text-sm text-gray-700 mb-2">
        {enableCriticMarkup
          ? renderMarkdownWithCriticMarkup(content, {
              onClickRange: handleClickRange,
              commentBadgeMap: contentBadgeMap,
            })
          : content}
      </div>
      {assessmentInstructions && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">Assessment Instructions</div>
          <div className="text-xs text-gray-500 leading-relaxed">
            {enableCriticMarkup
              ? renderMarkdownWithCriticMarkup(assessmentInstructions, {
                  onClickRange: handleClickRange,
                  commentBadgeMap: assessmentBadgeMap,
                })
              : assessmentInstructions}
          </div>
        </div>
      )}
    </div>
  );
}
